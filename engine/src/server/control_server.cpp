#include "control_server.hpp"

#include "nlohmann/json.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr size_t kMaxCommandBytes = 512;
constexpr int kReapGraceMs = 100;
constexpr int kSigtermGraceMs = 1500;

// read up to newline; returns "" on timeout / cl
std::string read_line_bounded(int fd, size_t max_bytes, int timeout_ms) {
    std::string line;
    line.reserve(48);
    pollfd pfd{fd, POLLIN, 0};
    for (;;) {
        int pr = poll(&pfd, 1, timeout_ms);
        if (pr <= 0) {
            return "";  // timeout or poll error
        }
        char c = 0;
        ssize_t n = recv(fd, &c, 1, 0);
        if (n == 1) {
            if (c == '\n') {
                return line;
            }
            line.push_back(c);
            if (line.size() >= max_bytes) {
                return "";  // refused oversized command
            }
            continue;
        }
        if (n == 0) {
            return line;  // EOF: honor whatever arrived before close
        }
        if (errno == EINTR) {
            continue;
        }
        return "";
    }
}

std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char ch : s) {
        if (ch == ' ') {
            if (!cur.empty()) {
                out.push_back(std::move(cur));
                cur.clear();
            }
        } else {
            cur.push_back(ch);
        }
    }
    if (!cur.empty()) {
        out.push_back(std::move(cur));
    }
    return out;
}

bool parse_uint(const std::string& s, size_t* out) {
    if (s.empty() || s.size() > 9) {
        return false;
    }
    size_t v = 0;
    for (char ch : s) {
        if (ch < '0' || ch > '9') {
            return false;
        }
        v = v * 10 + static_cast<size_t>(ch - '0');
    }
    *out = v;
    return true;
}

}  // namespace

AdminServer::AdminServer(uint16_t port, size_t timeout_s, std::string botnet_path,
                         uint32_t attack_max_rps, uint32_t attack_max_threads,
                         uint32_t attack_max_duration, RateLimiter* limiter)
    : port_(port),
      timeout_s_(timeout_s),
      botnet_path_(std::move(botnet_path)),
      attack_max_rps_(attack_max_rps),
      attack_max_threads_(attack_max_threads),
      attack_max_duration_(attack_max_duration),
      limiter_(limiter) {}

AdminServer::~AdminServer() {
    stop();
}

void AdminServer::start() {
    listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
        perror("admin socket");
        return;
    }

    int flags = fcntl(listen_fd_, F_GETFD, 0);
    fcntl(listen_fd_, F_SETFD, flags | FD_CLOEXEC);

    int opt = 1;
    setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port_);
    if (bind(listen_fd_, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("admin bind");
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }
    if (listen(listen_fd_, 2) < 0) {
        std::perror("admin listen");
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }

    std::printf("admin control socket listening on 127.0.0.1:%u\n", port_);
    running_.store(true, std::memory_order_relaxed);
    thread_ = std::thread([this] { run_loop(); });
}

void AdminServer::stop() {
    running_.store(false, std::memory_order_relaxed);
    if (listen_fd_ >= 0) {
        ::close(listen_fd_);  // wakes the blocked accept()
        listen_fd_ = -1;
    }
    if (thread_.joinable()) {
        thread_.join();
    }
    // Bounded shutdown: SIGTERM, then SIGKILL if the botnet lingers.
    if (baseline_running_.load(std::memory_order_relaxed) && baseline_pid_ > 0) {
        ::kill(baseline_pid_, SIGTERM);
        for (int i = 0; i < kSigtermGraceMs / kReapGraceMs; ++i) {
            reap_child();
            if (!baseline_running_.load(std::memory_order_relaxed)) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(kReapGraceMs));
        }
        if (baseline_running_.load(std::memory_order_relaxed)) {
            ::kill(baseline_pid_, SIGKILL);
            ::waitpid(baseline_pid_, nullptr, 0);
            baseline_running_.store(false, std::memory_order_relaxed);
            baseline_pid_ = 0;
        }
    }
    if (attack_running_.load(std::memory_order_relaxed) && child_pid_ > 0) {
        ::kill(child_pid_, SIGTERM);
        for (int i = 0; i < kSigtermGraceMs / kReapGraceMs; ++i) {
            if (reap_child()) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(kReapGraceMs));
        }
        if (attack_running_.load(std::memory_order_relaxed)) {
            ::kill(child_pid_, SIGKILL);
            ::waitpid(child_pid_, nullptr, 0);
            attack_running_.store(false, std::memory_order_relaxed);
            child_pid_ = 0;
        }
    }
}

void AdminServer::run_loop() {
    while (running_.load(std::memory_order_relaxed)) {
        // poll before accepting: a blocking accept() cannot be woken by
        // close() from another thread, so we use a short poll timeout and
        // let the running_ flag be checked each pass.
        pollfd pfd{listen_fd_, POLLIN, 0};
        int pr = poll(&pfd, 1, 250);
        if (pr <= 0) {
            continue;  // timeout or EINTR -> re-check running_
        }

        int fd = accept(listen_fd_, nullptr, nullptr);
        if (fd < 0) {
            if (errno == EINTR && running_.load(std::memory_order_relaxed)) {
                continue;
            }
            break;  // socket closed on stop() or hard error
        }

        // Fresh state before every command: the botnet may have naturally exited.
        reap_child();

        std::string line = read_line_bounded(fd, kMaxCommandBytes,
                                             static_cast<int>(timeout_s_) * 1000);
        std::string reply = line.empty() ? "ERR:INVALID_ARGS" : handle_command(line);
        ::send(fd, reply.data(), reply.size(), MSG_NOSIGNAL);
        ::send(fd, "\n", 1, MSG_NOSIGNAL);
        ::close(fd);
    }
    if (listen_fd_ >= 0) {
        ::close(listen_fd_);
        listen_fd_ = -1;
    }
}

std::string AdminServer::handle_command(const std::string& line) {
    std::vector<std::string> t = split_ws(line);
    if (t.empty()) {
        return "ERR:INVALID_ARGS";
    }
    const std::string& cmd = t[0];

    if (cmd == "CMD_GET_STATUS") {
        nlohmann::json j = {
            {"mitigation", limiter_ ? limiter_->enabled() : true},
            {"algorithm", limiter_
                              ? (limiter_->algorithm() ==
                                         RateLimiterConfig::Algorithm::kSlidingWindow
                                     ? "sliding_window"
                                     : "token_bucket")
                              : "token_bucket"},
            {"attack_running", attack_running_.load(std::memory_order_relaxed)},
            {"pid", attack_running_.load(std::memory_order_relaxed) ? child_pid_ : 0},
            {"baseline_running", baseline_running_.load(std::memory_order_relaxed)},
            {"baseline_bots", baseline_bots_},
            {"attack_params",
             {{"rps", last_attack_rps_},
              {"threads", last_attack_threads_},
              {"duration", last_attack_duration_}}},
        };
        return "OK:STATUS " + j.dump();
    }

    if (cmd == "CMD_SET_MITIGATION") {
        if (t.size() != 2 || (t[1] != "on" && t[1] != "off")) {
            return "ERR:INVALID_ARGS";
        }
        if (limiter_) {
            limiter_->set_enabled(t[1] == "on");
        }
        return std::string("OK:MITIGATION ") + t[1];
    }

    if (cmd == "CMD_BAN_VIP") {
        if (t.size() != 2) {
            return "ERR:INVALID_ARGS";
        }
        if (!limiter_ || !limiter_->manual_ban(t[1])) {
            return "ERR:INVALID_ARGS";  // bad ip or loopback refused
        }
        return "OK:BANNED " + t[1];
    }

    if (cmd == "CMD_UNBAN_VIP") {
        if (t.size() != 2) {
            return "ERR:INVALID_ARGS";
        }
        if (!limiter_ || !limiter_->manual_unban(t[1])) {
            return "ERR:NOT_BANNED " + t[1];
        }
        return "OK:UNBANNED " + t[1];
    }

    if (cmd == "CMD_START_ATTACK") {
        if (t.size() != 4) {
            return "ERR:INVALID_ARGS";
        }
        size_t rps = 0, threads = 0, duration = 0;
        if (!parse_uint(t[1], &rps) || !parse_uint(t[2], &threads) || !parse_uint(t[3], &duration) ||
            rps > attack_max_rps_ || threads > attack_max_threads_ ||
            duration > attack_max_duration_) {
            return "ERR:INVALID_ARGS";  // resource caps enforced
        }
        return start_attack(rps, threads, duration);
    }

    if (cmd == "CMD_STOP_ATTACK") {
        if (t.size() != 1) {
            return "ERR:INVALID_ARGS";
        }
        return stop_attack();
    }

    if (cmd == "CMD_SET_ALGORITHM") {
        if (t.size() != 2 ||
            (t[1] != "token_bucket" && t[1] != "sliding_window")) {
            return "ERR:INVALID_ARGS";
        }
        if (limiter_) {
            limiter_->set_algorithm(
                t[1] == "sliding_window"
                    ? RateLimiterConfig::Algorithm::kSlidingWindow
                    : RateLimiterConfig::Algorithm::kTokenBucket);
        }
        return std::string("OK:ALGORITHM ") + t[1];
    }

    if (cmd == "CMD_SET_BASELINE") {
        if (t.size() < 2 || t.size() > 3) {
            return "ERR:INVALID_ARGS";
        }
        if (t[1] == "off" && t.size() == 2) {
            return stop_baseline();
        }
        if (t[1] == "on" && t.size() == 3) {
            size_t bots = 0;
            if (!parse_uint(t[2], &bots) || bots < 1 ||
                bots > attack_max_threads_) {
                return "ERR:INVALID_ARGS";  // resource caps enforced
            }
            return start_baseline(bots);
        }
        return "ERR:INVALID_ARGS";
    }

    if (cmd == "CMD_EMERGENCY_STOP") {
        if (t.size() != 1) {
            return "ERR:INVALID_ARGS";
        }
        return emergency_stop();
    }

    return "ERR:UNKNOWN_COMMAND";
}

std::string AdminServer::start_attack(size_t rps, size_t threads, size_t duration) {
    if (attack_running_.load(std::memory_order_relaxed)) {
        return "ERR:ATTACK_ALREADY_RUNNING";
    }
    if (botnet_path_.empty()) {
        return "ERR:INVALID_ARGS";
    }

    pid_t pid = fork();
    if (pid < 0) {
        std::perror("fork");
        return "ERR:INTERNAL";
    }
    if (pid == 0) {
        // Child: exec the botnet; exec closes the FD_CLOEXEC server fds.
        std::vector<std::string> args = {
            botnet_path_,
            "--rps", std::to_string(rps),
            "--threads", std::to_string(threads),
            "--duration", std::to_string(duration),
        };
        std::vector<char*> argv;
        argv.reserve(args.size() + 1);
        for (auto& a : args) {
            argv.push_back(a.data());
        }
        argv.push_back(nullptr);
        execv(botnet_path_.c_str(), argv.data());
        _exit(127);  // bad path or exec failure
    }

    attack_running_.store(true, std::memory_order_relaxed);
    child_pid_ = pid;
    last_attack_rps_ = rps;
    last_attack_threads_ = threads;
    last_attack_duration_ = duration;
    return "OK:ATTACK_STARTED " + std::to_string(pid);
}

std::string AdminServer::stop_attack() {
    if (!attack_running_.load(std::memory_order_relaxed) || child_pid_ <= 0) {
        return "ERR:NO_ATTACK_RUNNING";
    }
    ::kill(child_pid_, SIGTERM);
    for (int i = 0; i < kSigtermGraceMs / kReapGraceMs; ++i) {
        reap_child();  // clears attack_running_ once the botnet exits
        if (!attack_running_.load(std::memory_order_relaxed)) {
            return "OK:ATTACK_STOPPED";
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(kReapGraceMs));
    }
    // Bounded stop: escalate to SIGKILL instead of leaving an orphan.
    ::kill(child_pid_, SIGKILL);
    ::waitpid(child_pid_, nullptr, 0);
    attack_running_.store(false, std::memory_order_relaxed);
    child_pid_ = 0;
    return "OK:ATTACK_STOPPED";
}

std::string AdminServer::start_baseline(size_t bots) {
    if (baseline_running_.load(std::memory_order_relaxed)) {
        return "ERR:BASELINE_ALREADY_RUNNING";
    }
    if (botnet_path_.empty()) {
        return "ERR:INVALID_ARGS";
    }

    pid_t pid = fork();
    if (pid < 0) {
        std::perror("fork");
        return "ERR:INTERNAL";
    }
    if (pid == 0) {
        // Child: baseline botnet in normal mode, ~1 rps per bot, indefinite.
        std::vector<std::string> args = {
            botnet_path_,
            "--normal",
            "--rps", std::to_string(bots),
            "--threads", std::to_string(bots),
            "--duration", "0",
        };
        std::vector<char*> argv;
        argv.reserve(args.size() + 1);
        for (auto& a : args) {
            argv.push_back(a.data());
        }
        argv.push_back(nullptr);
        execv(botnet_path_.c_str(), argv.data());
        _exit(127);
    }

    baseline_running_.store(true, std::memory_order_relaxed);
    baseline_pid_ = pid;
    baseline_bots_ = bots;
    return "OK:BASELINE_STARTED " + std::to_string(pid);
}

std::string AdminServer::stop_baseline() {
    if (!baseline_running_.load(std::memory_order_relaxed) || baseline_pid_ <= 0) {
        return "ERR:NO_BASELINE_RUNNING";
    }
    ::kill(baseline_pid_, SIGTERM);
    for (int i = 0; i < kSigtermGraceMs / kReapGraceMs; ++i) {
        reap_child();  // clears baseline_running_ once it exits
        if (!baseline_running_.load(std::memory_order_relaxed)) {
            return "OK:BASELINE_STOPPED";
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(kReapGraceMs));
    }
    ::kill(baseline_pid_, SIGKILL);
    ::waitpid(baseline_pid_, nullptr, 0);
    baseline_running_.store(false, std::memory_order_relaxed);
    baseline_pid_ = 0;
    return "OK:BASELINE_STOPPED";
}

std::string AdminServer::emergency_stop() {
    // Kill both children immediately, no grace window. Mitigation state is
    // deliberately left alone so the operator sees what it was doing.
    if (baseline_running_.load(std::memory_order_relaxed) && baseline_pid_ > 0) {
        ::kill(baseline_pid_, SIGKILL);
        ::waitpid(baseline_pid_, nullptr, 0);
        baseline_running_.store(false, std::memory_order_relaxed);
        baseline_pid_ = 0;
    }
    if (attack_running_.load(std::memory_order_relaxed) && child_pid_ > 0) {
        ::kill(child_pid_, SIGKILL);
        ::waitpid(child_pid_, nullptr, 0);
        attack_running_.store(false, std::memory_order_relaxed);
        child_pid_ = 0;
    }
    return "OK:EMERGENCY_STOP";
}

// returns true when BOTH children are gone (reaped or never running)
bool AdminServer::reap_child() {
    bool all_done = true;

    if (attack_running_.load(std::memory_order_relaxed) && child_pid_ > 0) {
        int status = 0;
        pid_t r = waitpid(child_pid_, &status, WNOHANG);
        if (r == child_pid_) {
            attack_running_.store(false, std::memory_order_relaxed);
            child_pid_ = 0;
        } else {
            all_done = false;  // still running (or EINTR, treated as alive)
        }
    }

    if (baseline_running_.load(std::memory_order_relaxed) && baseline_pid_ > 0) {
        int status = 0;
        pid_t r = waitpid(baseline_pid_, &status, WNOHANG);
        if (r == baseline_pid_) {
            baseline_running_.store(false, std::memory_order_relaxed);
            baseline_pid_ = 0;
        } else {
            all_done = false;
        }
    }

    return all_done;
}