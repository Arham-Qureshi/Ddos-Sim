#include "server.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

EpollServer::EpollServer(uint16_t port, size_t worker_count, TelemetryStats* stats)
    : port_(port), stats_(stats), pool_(worker_count, stats) {}

EpollServer::~EpollServer() {
    if (epoll_fd_ >= 0) {
        close(epoll_fd_);
    }
    if (listen_fd_ >= 0) {
        close(listen_fd_);
    }
}

bool EpollServer::init_socket() {
    listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
        perror("socket");
        return false;
    }

    int opt = 1;
    if (setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt");
        return false;
    }

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port_);
    if (bind(listen_fd_, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) < 0) {
        perror("bind");
        return false;
    }

    if (listen(listen_fd_, SOMAXCONN) < 0) {
        perror("listen");
        return false;
    }

    int flags = fcntl(listen_fd_, F_GETFL, 0);
    if (flags < 0 || fcntl(listen_fd_, F_SETFL, flags | O_NONBLOCK) < 0) {
        perror("fcntl O_NONBLOCK");
        return false;
    }

    epoll_fd_ = epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd_ < 0) {
        perror("epoll_create1");
        return false;
    }

    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = listen_fd_;
    if (epoll_ctl(epoll_fd_, EPOLL_CTL_ADD, listen_fd_, &ev) < 0) {
        perror("epoll_ctl");
        return false;
    }

    std::printf("ddos_server listening on 127.0.0.1:%u\n", port_);
    return true;
}

void EpollServer::accept_connections() {
    for (;;) {
        if (!running_.load(std::memory_order_relaxed)) {
            return;
        }
        int client_fd = accept4(listen_fd_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (client_fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                break;
            }
            if (errno == EINTR) {
                continue;
            }
            perror("accept4");
            break;
        }
        if (stats_) {
            stats_->active_connections.fetch_add(1, std::memory_order_relaxed);
            stats_->total_accepted.fetch_add(1, std::memory_order_relaxed);
        }
        pool_.enqueue(client_fd);
    }
}

void EpollServer::run() {
if (!init_socket()) {
        return;
    }

    std::array<epoll_event, 128> events{};
    while (running_.load(std::memory_order_relaxed)) {
        int n = epoll_wait(epoll_fd_, events.data(), static_cast<int>(events.size()), 200);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("epoll_wait");
            break;
        }
        for (int i = 0; i < n; ++i) {
            if (events[i].data.fd == listen_fd_) {
                accept_connections();
            }
        }
    }
}

void EpollServer::request_shutdown() {
    running_.store(false, std::memory_order_relaxed);
}

void EpollServer::stop_pool() {
    pool_.stop();
}