#include "control_server.hpp"
#include "nlohmann/json.hpp"

#include "rate_limiter.hpp"
#include "server.hpp"
#include "telemetry.hpp"

#include <csignal>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace {

EpollServer* g_server = nullptr;

void handle_signal(int) {
    if (g_server) {
        g_server->request_shutdown();
    }
}

struct ServerConfig {
    uint16_t port = 8080;
    uint16_t telemetry_udp_port = 9090;
    size_t worker_threads = 4;
    uint32_t rate_limit_max_rps = 20;
    uint32_t rate_limit_block_seconds = 10;
    RateLimiterConfig::Algorithm rate_limit_algorithm =
        RateLimiterConfig::Algorithm::kTokenBucket;
    uint16_t admin_control_port = 9091;
    std::string botnet_binary_path = "build/ddos_botnet";
    uint32_t attack_max_rps = 1000;
    uint32_t attack_max_threads = 64;
    uint32_t attack_max_duration = 300;
    size_t admin_read_timeout_s = 5;
};

ServerConfig load_config(const std::string& path) {
    ServerConfig cfg;
    std::ifstream file(path);
    if (!file.is_open()) {
        std::cerr << "Warning: could not open " << path
                  << ", using defaults (port " << cfg.port
                  << ", workers " << cfg.worker_threads << ")\n";
        return cfg;
    }
    try {
        nlohmann::json j;
        file >> j;
        cfg.port = j.value("target_server_port", cfg.port);
        cfg.telemetry_udp_port = j.value("telemetry_udp_port", cfg.telemetry_udp_port);
        cfg.worker_threads = j.value("worker_threads", cfg.worker_threads);
        cfg.rate_limit_max_rps = j.value("rate_limit_max_rps", cfg.rate_limit_max_rps);
        cfg.rate_limit_block_seconds =
            j.value("rate_limit_block_seconds", cfg.rate_limit_block_seconds);
        cfg.admin_control_port = j.value("admin_control_port", cfg.admin_control_port);
        cfg.botnet_binary_path = j.value("botnet_binary_path", cfg.botnet_binary_path);
        cfg.attack_max_rps = j.value("attack_max_rps", cfg.attack_max_rps);
        cfg.attack_max_threads = j.value("attack_max_threads", cfg.attack_max_threads);
        cfg.attack_max_duration = j.value("attack_max_duration", cfg.attack_max_duration);
        cfg.admin_read_timeout_s = j.value("admin_read_timeout_s", cfg.admin_read_timeout_s);
        std::string algo = j.value("rate_limit_algorithm", std::string("token_bucket"));
        if (algo == "sliding_window") {
            cfg.rate_limit_algorithm = RateLimiterConfig::Algorithm::kSlidingWindow;
        } else if (algo != "token_bucket") {
            std::cerr << "Warning: unknown rate_limit_algorithm '" << algo
                      << "', using token_bucket\n";
        }
        if (cfg.rate_limit_max_rps == 0) {
            std::cerr << "Warning: rate_limit_max_rps must be >= 1, using 20\n";
            cfg.rate_limit_max_rps = 20;
        }
        if (cfg.attack_max_rps == 0) cfg.attack_max_rps = 1000;
        if (cfg.attack_max_threads == 0) cfg.attack_max_threads = 64;
        if (cfg.attack_max_duration == 0) cfg.attack_max_duration = 300;
    } catch (const std::exception& e) {
        std::cerr << "Warning: failed to parse " << path << " (" << e.what()
                  << "), using defaults\n";
    }
    return cfg;
}

}  // namespace

int main(int argc, char* argv[]) {
    std::string config_path = "config/ddos_sim_config.json";
    if (argc > 1) {
        config_path = argv[1];
    }

    ServerConfig cfg = load_config(config_path);
    std::cout << "ddos-server starting (config: " << config_path << ")\n";
    std::cout
        << "mitigation: "
        << (cfg.rate_limit_algorithm == RateLimiterConfig::Algorithm::kSlidingWindow
                ? "sliding_window"
                : "token_bucket")
        << ", max " << cfg.rate_limit_max_rps << " rps, ban "
        << cfg.rate_limit_block_seconds << "s\n";

    TelemetryStats stats;
    RateLimiterConfig limiter_cfg;
    limiter_cfg.max_rps = cfg.rate_limit_max_rps;
    limiter_cfg.block_seconds = cfg.rate_limit_block_seconds;
    limiter_cfg.algorithm = cfg.rate_limit_algorithm;
    RateLimiter limiter(limiter_cfg);

    EpollServer server(cfg.port, cfg.worker_threads, &stats, &limiter);
    AdminServer admin(cfg.admin_control_port, cfg.admin_read_timeout_s,
                      cfg.botnet_binary_path, cfg.attack_max_rps,
                      cfg.attack_max_threads, cfg.attack_max_duration, &limiter);
    TelemetryBroadcaster telemetry(cfg.telemetry_udp_port, stats, &limiter);
    g_server = &server;

    struct sigaction sa {};
    sa.sa_handler = handle_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);

    // a peer that closes mid-reply must not kill us with SIGPIPE; send()
    // then surfaces EPIPE and we simply move on
    std::signal(SIGPIPE, SIG_IGN);

    telemetry.start();
    admin.start();
    server.run();
    admin.stop();
    server.stop_pool();
    telemetry.stop();
    g_server = nullptr;

    std::cout << "ddos-server shut down cleanly (active connections at exit: "
              << stats.active_connections.load() << ")\n";
    return 0;
}