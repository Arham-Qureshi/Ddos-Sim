#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct RecentBlock {
    std::string vip;
    uint64_t unblock_ts;  // steady_clock ms
};

struct RateLimiterConfig {
    uint32_t max_rps = 20;
    uint32_t block_seconds = 10;

    enum class Algorithm { kTokenBucket, kSlidingWindow };
    Algorithm algorithm = Algorithm::kTokenBucket;
};

class RateLimiter {
public:
    explicit RateLimiter(RateLimiterConfig cfg);

    RateLimiter(const RateLimiter&) = delete;
    RateLimiter& operator=(const RateLimiter&) = delete;

    // true = pass (serve), false = drop (ban + close).
    bool allow(const std::string& vip);
    // Snapshot of the most recent bans, newest last, capped at 16.
    std::vector<RecentBlock> recent_blocks() const;

private:
    bool is_banned(const std::string& vip, uint64_t now_ms);
    bool allow_token_bucket(const std::string& vip, uint64_t now_ms);
    bool allow_sliding_window(const std::string& vip, uint64_t now_ms);
    void ban(const std::string& vip, uint64_t now_ms);
    void maybe_prune(uint64_t now_ms);

    RateLimiterConfig cfg_;

    struct BanEntry {
        uint64_t unblock_ts;
    };
    std::unordered_map<std::string, BanEntry> banned_;

    struct BucketState {
        double tokens = 0.0;
        uint64_t last_refill_ms = 0;
    };
    std::unordered_map<std::string, BucketState> buckets_;

    std::unordered_map<std::string, std::deque<uint64_t>> windows_;

    mutable std::shared_mutex mutex_;
    std::deque<RecentBlock> recent_blocks_;
    std::atomic<uint64_t> calls_since_prune_{0};
};