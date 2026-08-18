#include "netutil.hpp"
#include "rate_limiter.hpp"
#include "server.hpp"

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <string>

namespace {

constexpr size_t kMaxVipLine = 256;
constexpr int kPollTimeoutMs = 200;
constexpr const char* kAdminIp = "127.0.0.1";

// Read until '\n' (max kMaxVipLine bytes). Non-blocking + poll-backed,
// mirroring the worker's drain loop.
// Returns the line without the trailing '\n', or "" on:
// pure EOF, clear error, poll timeout, or > kMaxVipLine bytes without '\n'.
std::string read_first_line(int fd) {
    std::string line;
    line.reserve(32);
    for (;;) {
        char c = 0;
        ssize_t n = recv(fd, &c, 1, 0);
        if (n == 1) {
            if (c == '\n') {
                if (!line.empty() && line.back() == '\r') {
                    line.pop_back();  // tolerate CRLF
                }
                return line;
            }
            line.push_back(c);
            if (line.size() >= kMaxVipLine) {
                return "";  // no newline seen in time
            }
            continue;
        }
        if (n == 0) {
            return "";  // peer closed before sending a line
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            pollfd pfd{fd, POLLIN, 0};
            int r = poll(&pfd, 1, kPollTimeoutMs);
            if (r == 0 || r < 0) {
                return "";  // timeout or poll error
            }
            continue;
        }
        return "";
    }
}

// Returns the virtual IP if the line is a valid "VIP:x.x.x.x", else "".
std::string parse_vip(const std::string& line) {
    constexpr const char* kPrefix = "VIP:";
    if (line.compare(0, 4, kPrefix) != 0) {
        return "";
    }
    std::string ip = line.substr(4);
    return valid_ipv4(ip) ? ip : "";
}

}  // namespace

ThreadPool::ThreadPool(size_t worker_count, TelemetryStats* stats, RateLimiter* rate_limiter)
    : stats_(stats), rate_limiter_(rate_limiter) {
    workers_.reserve(worker_count);
    for (size_t i = 0; i < worker_count; ++i) {
        workers_.emplace_back([this, idx = static_cast<uint32_t>(i)] { worker_main(idx); });
    }
}

ThreadPool::~ThreadPool() {
    stop();
}

void ThreadPool::worker_main(uint32_t worker_index) {
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

        if (rate_limiter_) {
            std::string line = read_first_line(client_fd);
            std::string vip = parse_vip(line);
            if (!vip.empty() && vip != kAdminIp && !rate_limiter_->allow(vip, worker_index)) {
                if (stats_) {
                    stats_->attack_accepted.fetch_add(1, std::memory_order_relaxed);
                    stats_->blocked_accepted.fetch_add(1, std::memory_order_relaxed);
                }
                finish(client_fd);
                continue;
            }
        }
        if (stats_) {
            stats_->normal_accepted.fetch_add(1, std::memory_order_relaxed);
        }
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
                break;  // done with this connection, back to the queue
            }
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                finish(client_fd);
                break;  // one bad connection must not kill the worker
            }
            pollfd pfd{client_fd, POLLIN, 0};
            int r = poll(&pfd, 1, 200);
            if (r < 0 && errno != EINTR) {
                finish(client_fd);
                break;  // one bad connection must not kill the worker
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