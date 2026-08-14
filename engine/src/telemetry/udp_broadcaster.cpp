#include "telemetry.hpp"

#include "nlohmann/json.hpp"
#include "rate_limiter.hpp"

#include <arpa/inet.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <sstream>
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
    std::string line;
    if (!std::getline(stat, line)) {
        return 0;
    }
    // comm (field 2) can contain spaces/parens, so locate its closing ')'
    std::string::size_type close = line.rfind(')');
    if (close == std::string::npos) {
        return 0;
    }
    // after comm come state..cmajflt (fields 3-13), then utime(14)+stime(15)
    std::istringstream rest(line.substr(close + 1));
    std::string dummy;
    for (int i = 3; i <= 13; ++i) {
        rest >> dummy;
    }
    uint64_t utime = 0, stime = 0;
    rest >> utime >> stime;
    return utime + stime;
}

}  // namespace

TelemetryBroadcaster::TelemetryBroadcaster(uint16_t port, TelemetryStats& stats,
                                           RateLimiter* rate_limiter)
    : port_(port), stats_(stats), rate_limiter_(rate_limiter) {}

TelemetryBroadcaster::~TelemetryBroadcaster() {
    stop();
}

void TelemetryBroadcaster::start() {
    sock_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock_fd_ < 0) {
        perror("telemetry socket");
        return;
    }
    int flags = fcntl(sock_fd_, F_GETFD, 0);
    fcntl(sock_fd_, F_SETFD, flags | FD_CLOEXEC);  // don't leak into exec'd botnet

    dest_.sin_family = AF_INET;
    dest_.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    dest_.sin_port = htons(port_);

    last_normal_accepted_ = stats_.normal_accepted.load(std::memory_order_relaxed);
    last_attack_accepted_ = stats_.attack_accepted.load(std::memory_order_relaxed);
    last_blocked_accepted_ = stats_.blocked_accepted.load(std::memory_order_relaxed);
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

        auto snap = [](const std::atomic<uint64_t>& counter, uint64_t& last) {
            uint64_t value = counter.load(std::memory_order_relaxed);
            uint64_t delta = value - last;
            last = value;
            return delta;
        };
        stats_.normal_rps.store(snap(stats_.normal_accepted, last_normal_accepted_) * 2,
                                std::memory_order_relaxed);
        stats_.attack_rps.store(snap(stats_.attack_accepted, last_attack_accepted_) * 2,
                                std::memory_order_relaxed);
        stats_.blocked_rps.store(snap(stats_.blocked_accepted, last_blocked_accepted_) * 2,
                                 std::memory_order_relaxed);
        // all accepted sockets (normal + attack + blocked) -> flood arrival rate
        stats_.connections_per_sec.store(
            snap(stats_.total_accepted, last_total_accepted_) * 2, std::memory_order_relaxed);

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

        nlohmann::json blocks = nlohmann::json::array();
        if (rate_limiter_) {
            for (const RecentBlock& b : rate_limiter_->recent_blocks()) {
                blocks.push_back({{"vip", b.vip}, {"unblock_ts", b.unblock_ts}});
            }
        }

        nlohmann::json payload = {
            {"timestamp",
             std::chrono::duration_cast<std::chrono::seconds>(
                 std::chrono::system_clock::now().time_since_epoch())
                 .count()},
            {"metrics", {{"normal_rps", stats_.normal_rps.load(std::memory_order_relaxed)},
                         {"attack_rps", stats_.attack_rps.load(std::memory_order_relaxed)},
                         {"blocked_rps", stats_.blocked_rps.load(std::memory_order_relaxed)},
                         {"cpu_load_pct", pct},
                         {"connections_per_sec",
                          stats_.connections_per_sec.load(std::memory_order_relaxed)},
                         {"active_connections",
                          stats_.active_connections.load(std::memory_order_relaxed)}}},
            {"recent_blocks", blocks}};

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