#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_stop{false};

void handle_signal(int) {
    g_stop.store(true);
}

struct Options {
    uint16_t port = 8080;
    size_t threads = 4;
    size_t rps = 0;
    size_t duration_secs = 300;
};

void print_usage(const char* prog) {
    std::printf("usage: %s --rps <n> [--port <n>] [--threads <n>] [--duration <n>]\n", prog);
    std::printf("  --rps      requests per second (required)\n");
    std::printf("  --port     target port (default 8080)\n");
    std::printf("  --threads  worker threads (default 4)\n");
    std::printf("  --duration seconds (default 300, hard max 300)\n");
}

bool parse_args(int argc, char* argv[], Options& opts) {
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto value = [&](const char* flag) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "%s requires a value\n", flag);
                return nullptr;
            }
            return argv[++i];
        };
        if (arg == "--port") {
            const char* v = value("--port");
            if (!v) return false;
            opts.port = static_cast<uint16_t>(std::atoi(v));
        } else if (arg == "--threads") {
            const char* v = value("--threads");
            if (!v) return false;
            opts.threads = static_cast<size_t>(std::atoi(v));
        } else if (arg == "--rps") {
            const char* v = value("--rps");
            if (!v) return false;
            opts.rps = static_cast<size_t>(std::atoi(v));
        } else if (arg == "--duration") {
            const char* v = value("--duration");
            if (!v) return false;
            opts.duration_secs = static_cast<size_t>(std::atoi(v));
        } else {
            std::fprintf(stderr, "unknown flag: %s\n", arg.c_str());
            return false;
        }
    }
    if (opts.rps == 0) { std::fprintf(stderr, "--rps is required and must be > 0\n"); return false; }
    if (opts.threads == 0 || opts.threads > 64) { std::fprintf(stderr, "--threads must be 1..64\n"); return false; }
    if (opts.port == 0) { std::fprintf(stderr, "--port must be 1..65535\n"); return false; }
    if (opts.duration_secs == 0 || opts.duration_secs > 300) {
        std::fprintf(stderr, "--duration must be 1..300 (hard cap)\n");
        return false;
    }
    return true;
}

void worker(uint16_t port, long ns_per_req, std::atomic<uint64_t>& sent,
            std::atomic<uint64_t>& failed) {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<int> host(1, 254);

    while (!g_stop.load(std::memory_order_relaxed)) {
        if (ns_per_req > 0) {
            timespec ts{};
            ts.tv_sec = ns_per_req / 1000000000L;
            ts.tv_nsec = ns_per_req % 1000000000L;
            nanosleep(&ts, nullptr);
        }
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) { failed.fetch_add(1, std::memory_order_relaxed); continue; }
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(port);
        if (connect(fd, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) < 0) {
            close(fd);
            failed.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        char line[32];
        int n = std::snprintf(line, sizeof(line), "VIP:10.0.0.%d\n", host(gen));
        if (send(fd, line, static_cast<size_t>(n), 0) == n) {
            sent.fetch_add(1, std::memory_order_relaxed);
        } else {
            failed.fetch_add(1, std::memory_order_relaxed);
        }
        close(fd);
    }
}

}  // namespace

int main(int argc, char* argv[]) {
    Options opts;
    if (!parse_args(argc, argv, opts)) {
        print_usage(argv[0]);
        return 2;
    }

    struct sigaction sa {};
    sa.sa_handler = handle_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);

    size_t per_thread_rps = opts.rps / opts.threads;
    if (per_thread_rps == 0) per_thread_rps = 1;
    long ns_per_req = 1000000000L / static_cast<long>(per_thread_rps);

    std::printf("ddos_botnet: port %u, threads %zu, target %zu rps"
                " (actual ~%zu), duration %zu s\n",
                opts.port, opts.threads, opts.rps,
                per_thread_rps * opts.threads, opts.duration_secs);

    std::atomic<uint64_t> sent{0}, failed{0};
    std::vector<std::thread> workers;
    workers.reserve(opts.threads);
    for (size_t i = 0; i < opts.threads; ++i) {
        workers.emplace_back(worker, opts.port, ns_per_req,
                             std::ref(sent), std::ref(failed));
    }

    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::seconds(opts.duration_secs);
    while (!g_stop.load(std::memory_order_relaxed) &&
           std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    g_stop.store(true);

    for (auto& t : workers) {
        t.join();
    }

    std::printf("done: sent %llu, failed %llu, elapsed ~%zu s\n",
                static_cast<unsigned long long>(sent.load()),
                static_cast<unsigned long long>(failed.load()),
                opts.duration_secs);
    return 0;
}