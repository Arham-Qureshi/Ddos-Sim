#pragma once

#include <atomic>
#include <cstdint>
#include <thread>

#include <netinet/in.h>

#include <string>

class RateLimiter;

struct TelemetryStats {
    std::atomic<uint64_t> total_accepted{0};
    std::atomic<uint64_t> active_connections{0};
    std::atomic<uint64_t> normal_accepted{0};
    std::atomic<uint64_t> attack_accepted{0};
    std::atomic<uint64_t> blocked_accepted{0};
    std::atomic<uint64_t> normal_rps{0};
    std::atomic<uint64_t> attack_rps{0};
    std::atomic<uint64_t> blocked_rps{0};
    std::atomic<uint64_t> connections_per_sec{0};
    std::atomic<uint32_t> cpu_load_pct{0};
};

class TelemetryBroadcaster {
public:
    TelemetryBroadcaster(uint16_t port, TelemetryStats& stats, RateLimiter* rate_limiter);
    ~TelemetryBroadcaster();

    TelemetryBroadcaster(const TelemetryBroadcaster&) = delete;
    TelemetryBroadcaster& operator=(const TelemetryBroadcaster&) = delete;

    void start();
    void stop();

private:
    void run_loop();

    uint16_t port_;
    TelemetryStats& stats_;
    RateLimiter* rate_limiter_ = nullptr;
    int sock_fd_ = -1;
    sockaddr_in dest_{};
    std::thread thread_;
    std::atomic<bool> running_{false};

    uint64_t last_normal_accepted_ = 0;
    uint64_t last_attack_accepted_ = 0;
    uint64_t last_blocked_accepted_ = 0;
    uint64_t last_total_accepted_ = 0;
    uint64_t last_cpu_ticks_ = 0;
    uint64_t last_cpu_wall_ms_ = 0;
};