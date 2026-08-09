#include "telemetry.hpp"

#include "nlohmann/json.hpp"

#include <arpa/inet.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <unistd.h>

namespace {

constexpr auto kTick = std::chrono::milliseconds(500);

uint64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

uint64_t process_cpu_ticks() {
    std::ifstream stat("/proc/self/stat");
    if (!stat.is_open()) {
        return 0;
    }
    std::string dummy;
    for (int i = 0; i < 11; ++i) {
        stat >> dummy;
    }
    uint64_t utime = 0, stime = 0;
    stat >> utime >> stime;
    return utime + stime;
}

}  // namespace

TelemetryBroadcaster::TelemetryBroadcaster(uint16_t port, TelemetryStats& stats)
    : port_(port), stats_(stats) {}

TelemetryBroadcaster::~TelemetryBroadcaster() {
    stop();
}

void TelemetryBroadcaster::start() {
    sock_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock_fd_ < 0) {
        perror("telemetry socket");
        return;
    }

    dest_.sin_family = AF_INET;
    dest_.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    dest_.sin_port = htons(port_);

    last_total_accepted_ = stats_.total_accepted.load(std::memory_order_relaxed);
    last_cpu_ticks_ = process_cpu_ticks();
    last_cpu_wall_ms_ = now_ms();

    running_.store(true, std::memory_order_relaxed);
    thread_ = std::thread([this] { run_loop(); });
}

void TelemetryBroadcaster::stop() {
    running_.store(false, std::memory_order_relaxed);
    if (thread_.joinable()) {
        thread_.join();
    }
    if (sock_fd_ >= 0) {
        close(sock_fd_);
        sock_fd_ = -1;
    }
}

void TelemetryBroadcaster::run_loop() {
    while (running_.load(std::memory_order_relaxed)) {
        auto tick_start = std::chrono::steady_clock::now();

        uint64_t accepted = stats_.total_accepted.load(std::memory_order_relaxed);
        uint64_t delta = accepted - last_total_accepted_;
        last_total_accepted_ = accepted;
        stats_.normal_rps.store(delta * 2, std::memory_order_relaxed);

uint64_t wall_now = now_ms();
        uint64_t wall_delta = wall_now - last_cpu_wall_ms_;
        last_cpu_wall_ms_ = wall_now;
        uint64_t ticks = process_cpu_ticks();
        uint64_t tick_delta = ticks - last_cpu_ticks_;
        last_cpu_ticks_ = ticks;
        long ticks_per_sec = sysconf(_SC_CLK_TCK);
        uint32_t pct = 0;
        if (ticks_per_sec > 0 && wall_delta > 0) {
            double busy_secs = static_cast<double>(tick_delta) / ticks_per_sec;
            double wall_secs = static_cast<double>(wall_delta) / 1000.0;
            pct = static_cast<uint32_t>(busy_secs / wall_secs * 100.0);
            if (pct > 100) {
                pct = 100;
            }
        }
        stats_.cpu_load_pct.store(pct, std::memory_order_relaxed);

        nlohmann::json payload = {
            {"timestamp",
             std::chrono::duration_cast<std::chrono::seconds>(
                 std::chrono::system_clock::now().time_since_epoch())
                 .count()},
            {"metrics", {{"normal_rps", stats_.normal_rps.load(std::memory_order_relaxed)},
                         {"attack_rps", stats_.attack_rps.load(std::memory_order_relaxed)},
                         {"blocked_rps", stats_.blocked_rps.load(std::memory_order_relaxed)},
                         {"cpu_load_pct", pct},
                         {"active_connections",
                          stats_.active_connections.load(std::memory_order_relaxed)}}},
            {"recent_blocks", nlohmann::json::array()}};

        std::string json_str = payload.dump();
        sendto(sock_fd_, json_str.data(), json_str.size(), 0,
               reinterpret_cast<const sockaddr*>(&dest_), sizeof(dest_));

        auto elapsed = std::chrono::steady_clock::now() - tick_start;
        auto remaining = kTick - elapsed;
        if (remaining > std::chrono::milliseconds::zero()) {
            std::this_thread::sleep_for(remaining);
        }
    }
}