#pragma once

#include "telemetry.hpp"

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

class RateLimiter;

class ThreadPool {
public:
    explicit ThreadPool(size_t worker_count, TelemetryStats* stats, RateLimiter* rate_limiter);
    ~ThreadPool();

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    void enqueue(int client_fd);
    void stop();

private:
    void worker_main();

    std::vector<std::thread> workers_;
    std::queue<int> tasks_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::atomic<bool> stopping_{false};
    TelemetryStats* stats_ = nullptr;
    RateLimiter* rate_limiter_ = nullptr;
};

class EpollServer {
public:
    EpollServer(uint16_t port, size_t worker_count, TelemetryStats* stats, RateLimiter* rate_limiter);
    ~EpollServer();

    EpollServer(const EpollServer&) = delete;
    EpollServer& operator=(const EpollServer&) = delete;

    void run();
    void request_shutdown();
    void stop_pool();

private:
    int listen_fd_ = -1;
    int epoll_fd_ = -1;
    uint16_t port_;
    TelemetryStats* stats_ = nullptr;
    ThreadPool pool_;
    std::atomic<bool> running_{true};

    bool init_socket();
    void accept_connections();
};