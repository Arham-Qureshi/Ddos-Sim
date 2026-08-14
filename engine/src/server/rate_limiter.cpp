#include "rate_limiter.hpp"

#include "netutil.hpp"

#include <algorithm>
#include <chrono>
#include <mutex>

namespace {

constexpr uint64_t kWindowMs = 1000;
constexpr uint64_t kPruneInterval = 256;
constexpr size_t kMaxRecentBlocks = 16;
constexpr const char* kAdminIp = "127.0.0.1";

uint64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

}  // namespace

RateLimiter::RateLimiter(RateLimiterConfig cfg) : cfg_(cfg) {}

bool RateLimiter::allow(const std::string& vip) {
    if (!enabled_.load(std::memory_order_relaxed)) {
        return true;  // mitigation off: everyone passes
    }
    if (vip == kAdminIp) {
        return true;  // never rate-limit the admin/dashboard IP
    }
    uint64_t now = now_ms();
    if (calls_since_prune_.fetch_add(1, std::memory_order_relaxed) + 1 >= kPruneInterval) {
        maybe_prune(now);
    }
    if (is_banned(vip, now)) {
        return false;  // banned -> drop, no re-ban
    }

    bool ok = false;
    switch (cfg_.algorithm) {
        case RateLimiterConfig::Algorithm::kTokenBucket:
            ok = allow_token_bucket(vip, now);
            break;
        case RateLimiterConfig::Algorithm::kSlidingWindow:
            ok = allow_sliding_window(vip, now);
            break;
    }
    if (!ok) {
        ban(vip, now);
    }
    return ok;
}

bool RateLimiter::is_banned(const std::string& vip, uint64_t now_ms) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = banned_.find(vip);
    if (it == banned_.end()) {
        return false;
    }
    if (it->second.unblock_ts == 0) {
        return true;  // manual permanent ban
    }
    if (it->second.unblock_ts > now_ms) {
        return true;
    }
    // Expired ban: drop the read lock, write-lock, re-check, erase.
    lock.unlock();
    std::unique_lock<std::shared_mutex> wlock(mutex_);
    auto it2 = banned_.find(vip);
    if (it2 != banned_.end() && it2->second.unblock_ts <= now_ms) {
        banned_.erase(it2);
    }
    return false;
}

void RateLimiter::ban(const std::string& vip, uint64_t now_ms) {
    // Caller holds no lock when this is invoked.
    std::unique_lock<std::shared_mutex> lock(mutex_);
    uint64_t unblock = now_ms + static_cast<uint64_t>(cfg_.block_seconds) * 1000;
    banned_[vip] = BanEntry{unblock};
    buckets_.erase(vip);  // fresh slate once the ban expires
    windows_.erase(vip);
    recent_blocks_.push_back(RecentBlock{vip, unblock});
    while (recent_blocks_.size() > kMaxRecentBlocks) {
        recent_blocks_.pop_front();
    }
}

bool RateLimiter::allow_token_bucket(const std::string& vip, uint64_t now_ms) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    BucketState& b = buckets_[vip];
    if (b.last_refill_ms == 0) {
        b.tokens = static_cast<double>(cfg_.max_rps);  // start full
        b.last_refill_ms = now_ms;
    }
    double elapsed = static_cast<double>(now_ms - b.last_refill_ms) / 1000.0;
    double capacity = static_cast<double>(cfg_.max_rps);
    b.tokens = std::min(capacity, b.tokens + elapsed * capacity);
    b.last_refill_ms = now_ms;
    if (b.tokens < 1.0) {
        return false;  // bucket empty -> allow() bans
    }
    b.tokens -= 1.0;
    return true;
}

bool RateLimiter::allow_sliding_window(const std::string& vip, uint64_t now_ms) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    std::deque<uint64_t>& w = windows_[vip];
    while (!w.empty() && now_ms - w.front() >= kWindowMs) {
        w.pop_front();
    }
    if (w.size() >= static_cast<size_t>(cfg_.max_rps)) {
        return false;  // 20+ requests inside the last second -> drop
    }
    w.push_back(now_ms);
    return true;
}

void RateLimiter::maybe_prune(uint64_t now_ms) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    for (auto it = buckets_.begin(); it != buckets_.end();) {
        if (now_ms - it->second.last_refill_ms > 2 * kWindowMs) {
            it = buckets_.erase(it);  // bucket idle -> forget it
        } else {
            ++it;
        }
    }
    for (auto it = windows_.begin(); it != windows_.end();) {
        while (!it->second.empty() && now_ms - it->second.front() >= kWindowMs) {
            it->second.pop_front();
        }
        if (it->second.empty()) {
            it = windows_.erase(it);
        } else {
            ++it;
        }
    }
    for (auto it = banned_.begin(); it != banned_.end();) {
        if (it->second.unblock_ts != 0 && it->second.unblock_ts <= now_ms) {
            it = banned_.erase(it);  // expired ban -> forget
        } else {
            ++it;
        }
    }
    calls_since_prune_.store(0, std::memory_order_relaxed);
}

void RateLimiter::set_enabled(bool on) {
    enabled_.store(on, std::memory_order_relaxed);
}

bool RateLimiter::enabled() const {
    return enabled_.load(std::memory_order_relaxed);
}

bool RateLimiter::manual_ban(const std::string& vip) {
    if (vip == kAdminIp || !valid_ipv4(vip)) {
        return false;  // never ban loopback, reject junk
    }
    std::unique_lock<std::shared_mutex> lock(mutex_);
    banned_[vip] = BanEntry{0};  // 0 == permanent sentinel
    buckets_.erase(vip);
    windows_.erase(vip);
    recent_blocks_.push_back(RecentBlock{vip, 0});
    while (recent_blocks_.size() > kMaxRecentBlocks) {
        recent_blocks_.pop_front();
    }
    return true;
}

bool RateLimiter::manual_unban(const std::string& vip) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    auto it = banned_.find(vip);
    if (it == banned_.end()) {
        return false;
    }
    banned_.erase(it);
    return true;
}

std::vector<RecentBlock> RateLimiter::recent_blocks() const {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    uint64_t now = now_ms();
    std::vector<RecentBlock> out;
    for (const RecentBlock& b : recent_blocks_) {
        // expired temp bans are pointless to keep broadcasting; manual
        // permanent bans (unblock_ts == 0) stay until explicitly unbanned
        if (b.unblock_ts != 0 && b.unblock_ts <= now) {
            continue;
        }
        out.push_back(b);
    }
    return out;
}