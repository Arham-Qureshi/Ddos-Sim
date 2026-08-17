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

struct DecisionRecord {
    std::string vip;
    bool allowed;        // true = passed the rate limiter
    uint64_t ts_ms;      // steady_clock ms at decision time
    double tokens;       // token bucket: tokens remaining after the decision
    uint32_t window_count;  // sliding window: requests in window after the decision
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

    // Snapshot of the most recent per-packet decisions, newest last, capped at 128.
    std::vector<DecisionRecord> recent_decisions() const;

    // Mitigation master switch: when disabled, allow() always passes.
    void set_enabled(bool on);
    bool enabled() const;

    // Runtime algorithm switch (token bucket <-> sliding window).
    void set_algorithm(RateLimiterConfig::Algorithm algo);
    RateLimiterConfig::Algorithm algorithm() const;

    // Permanent ban/unban. Ban is refused (returns false) for an invalid
    // address; unban is refused when the vip is not currently banned.
    bool manual_ban(const std::string& vip);
    bool manual_unban(const std::string& vip);

private:
    bool is_banned(const std::string& vip, uint64_t now_ms);
    bool allow_token_bucket(const std::string& vip, uint64_t now_ms, double& tokens_out);
    bool allow_sliding_window(const std::string& vip, uint64_t now_ms, uint32_t& window_out);
    void ban(const std::string& vip, uint64_t now_ms);
    void record_decision(const std::string& vip, bool allowed, uint64_t now_ms,
                         double tokens, uint32_t window_count);
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
    std::deque<DecisionRecord> decisions_;
    std::atomic<uint64_t> calls_since_prune_{0};
    std::atomic<bool> enabled_{true};
    std::atomic<int> algorithm_{static_cast<int>(RateLimiterConfig::Algorithm::kTokenBucket)};
};
