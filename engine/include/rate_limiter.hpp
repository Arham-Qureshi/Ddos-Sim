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

struct VipStat {
    std::string vip;
    uint32_t active_rps;  // decisions from this VIP in the last 1s
    uint32_t sent;        // cumulative lifetime accepted packets
    uint32_t blocked;     // cumulative lifetime dropped packets
    uint32_t worker_id;   // server worker thread that handled the last decision
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
    bool allow(const std::string& vip, uint32_t worker_id);
    // Snapshot of the most recent bans, newest last, capped at 16.
    std::vector<RecentBlock> recent_blocks() const;

    // Snapshot of the most recent per-packet decisions, newest last, capped at 128.
    std::vector<DecisionRecord> recent_decisions() const;
    // Per-VIP running stats snapshot (vip -> rps/counters/worker).
    std::vector<VipStat> vip_stats() const;

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
                         double tokens, uint32_t window_count, uint32_t worker_id);
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

    struct VipAccum {
        uint32_t sent = 0;
        uint32_t blocked = 0;
        uint32_t last_worker = 0;
        std::deque<uint64_t> recent_ts;  // decision timestamps (ms)
    };
    std::unordered_map<std::string, VipAccum> vip_stats_;

    std::unordered_map<std::string, std::deque<uint64_t>> windows_;

    mutable std::shared_mutex mutex_;
    std::deque<RecentBlock> recent_blocks_;
    std::deque<DecisionRecord> decisions_;
    std::atomic<uint64_t> calls_since_prune_{0};
    std::atomic<bool> enabled_{true};
    std::atomic<int> algorithm_{static_cast<int>(RateLimiterConfig::Algorithm::kTokenBucket)};
};
