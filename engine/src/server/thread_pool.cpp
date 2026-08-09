#include "server.hpp"

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>

ThreadPool::ThreadPool(size_t worker_count, TelemetryStats* stats)
    : stats_(stats) {
    workers_.reserve(worker_count);
    for (size_t i = 0; i < worker_count; ++i) {
        workers_.emplace_back([this] { worker_main(); });
    }
}

ThreadPool::~ThreadPool() {
    stop();
}

void ThreadPool::worker_main() {
    for (;;) {
        int client_fd = -1;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
            if (stopping_ && tasks_.empty()) {
                return;
            }
            client_fd = tasks_.front();
            tasks_.pop();
        }

        char buffer[4096];
        auto finish = [this](int fd) {
            close(fd);
            if (stats_) {
                stats_->active_connections.fetch_sub(1, std::memory_order_relaxed);
            }
        };
        for (;;) {
            if (stopping_.load(std::memory_order_relaxed)) {
                finish(client_fd);
                return;
            }
            ssize_t n = recv(client_fd, buffer, sizeof(buffer), 0);
            if (n > 0) {
                continue;
            }
            if (n == 0) {
                finish(client_fd);
                return;
            }
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                finish(client_fd);
                return;
            }
            pollfd pfd{client_fd, POLLIN, 0};
            int r = poll(&pfd, 1, 200);
            if (r < 0 && errno != EINTR) {
                finish(client_fd);
                return;
            }
        }
    }
}

void ThreadPool::enqueue(int client_fd) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_) {
            close(client_fd);
            return;
        }
        tasks_.push(client_fd);
    }
    cv_.notify_one();
}

void ThreadPool::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stopping_ = true;
    }
    cv_.notify_all();
    for (auto& worker : workers_) {
        if (worker.joinable()) {
            worker.join();
        }
    }
    workers_.clear();

    std::lock_guard<std::mutex> lock(mutex_);
    while (!tasks_.empty()) {
        int client_fd = tasks_.front();
        tasks_.pop();
        close(client_fd);
        if (stats_) {
            stats_->active_connections.fetch_sub(1, std::memory_order_relaxed);
        }
    }
}