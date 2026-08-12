#pragma once

#include "rate_limiter.hpp"

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <sys/types.h>

// Loopback admin channel: accepts STRING commands over TCP and answers with
// one line. Owns the botnet child process lifecycle (spawn / stop / reap).
class AdminServer {
public:
    AdminServer(uint16_t port, size_t timeout_s, std::string botnet_path,
                uint32_t attack_max_rps, uint32_t attack_max_threads,
                uint32_t attack_max_duration, RateLimiter* limiter);
    ~AdminServer();

    AdminServer(const AdminServer&) = delete;
    AdminServer& operator=(const AdminServer&) = delete;

    void start();
    void stop();

    bool attack_running() const { return attack_running_.load(std::memory_order_relaxed); }

private:
    void run_loop();
    std::string handle_command(const std::string& line);
    std::string start_attack(size_t rps, size_t threads, size_t duration);
    std::string stop_attack();
    bool reap_child();

    uint16_t port_;
    size_t timeout_s_;
    std::string botnet_path_;
    uint32_t attack_max_rps_;
    uint32_t attack_max_threads_;
    uint32_t attack_max_duration_;
    RateLimiter* limiter_;

    int listen_fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::atomic<bool> attack_running_{false};
    pid_t child_pid_ = 0;
};