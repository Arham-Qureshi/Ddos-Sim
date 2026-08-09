#include "nlohmann/json.hpp"

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

    TelemetryStats stats;
    EpollServer server(cfg.port, cfg.worker_threads, &stats);
    TelemetryBroadcaster telemetry(cfg.telemetry_udp_port, stats);
    g_server = &server;

    struct sigaction sa {};
    sa.sa_handler = handle_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);

    telemetry.start();
    server.run();
    server.stop_pool();
    telemetry.stop();
    g_server = nullptr;

    std::cout << "ddos-server shut down cleanly (active connections at exit: "
              << stats.active_connections.load() << ")\n";
    return 0;
}