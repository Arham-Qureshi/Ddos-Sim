// timeline_buffer.js — AlgoMaster playback frame buffer (t11). Turns real
// C++ per-packet decisions into 100ms StateFrames for the t12 renderer and
// t13 scrubber. Pure module: no DOM, no GSAP. Frames + packets are pooled to
// keep the 60fps render loop GC-free.

export const FRAME_MS = 100; // one StateFrame = 100ms of sim
export const SUB_FRAMES_PER_TICK = 5; // the engine broadcasts every 500ms
export const FLIGHT_FRAMES = 4; // a packet stays visible for 4 frames
export const BUFFER_CAPACITY = 1000; // ~100s of history at 100ms/frame

const PACKET_POOL_SIZE = 4096; // covers steady state at 200rps; grows lazily if ever exceeded

function makePacket() {
  return { srcIp: "", botId: 0, progress: 0, status: "ALLOWED" };
}

function botIdFor(srcIp) {
  const m = /10\.0\.0\.(\d+)$/.exec(srcIp);
  return m ? Number(m[1]) : 0;
}

// human explanation, ticket format:
// "Frame 28 (2.8s): Bot #5 [10.0.0.5] sent request. Token Bucket empty (0/2). Packet DROPPED."
function explain(frame, cap) {
  const p = frame.activePackets.find((x) => x.status === "DROPPED") || frame.activePackets[0];
  if (!p) return `Frame ${frame.stepIndex}: no requests in this window.`;
  const secs = (frame.timestampMs / 1000).toFixed(1);
  const tokens = frame.algorithmMetrics.tokensRemaining;
  const algo =
    frame.activeAlgorithm === "sliding_window"
      ? `Sliding Window rate ${frame.algorithmMetrics.windowRate}/${cap} req/s`
      : `Token Bucket ${tokens <= 0 ? `empty (0/${cap})` : `${tokens.toFixed(0)}/${cap}`}`;
  return `Frame ${frame.stepIndex} (${secs}s): Bot #${p.botId} [${p.srcIp}] sent request. ${algo}. Packet ${p.status}.`;
}

export class TimelineBuffer {
  constructor({ capacity = BUFFER_CAPACITY, flightFrames = FLIGHT_FRAMES } = {}) {
    this.capacity = capacity;
    this.flightFrames = flightFrames;
    this.activeAlgorithm = "token_bucket";
    this.rateLimitMaxRps = 2;
    this.lastSeenTs = -1;
    this.stepIndex = 0;
    this.frames_ = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.frames_[i] = {
        stepIndex: 0,
        timestampMs: 0,
        activeAlgorithm: "token_bucket",
        algorithmMetrics: { tokensRemaining: 0, windowRate: 0 },
        activePackets: [],
        explanationText: "",
      };
    }
    this.write_ = 0; // ring write head
    this.length = 0;
    this.freeList_ = new Array(PACKET_POOL_SIZE);
    for (let i = 0; i < PACKET_POOL_SIZE; i++) this.freeList_[i] = makePacket();
    this.inFlight_ = []; // packets still travelling between frames
  }

  setAlgorithm(alg) {
    if (alg === "sliding_window" || alg === "token_bucket") this.activeAlgorithm = alg;
  }

  clear() {
    this.lastSeenTs = -1;
    this.stepIndex = 0;
    this.write_ = 0;
    this.length = 0;
    this.inFlight_ = [];
    this.freeList_ = new Array(PACKET_POOL_SIZE);
    for (let i = 0; i < PACKET_POOL_SIZE; i++) this.freeList_[i] = makePacket();
  }

  // keep the hot path allocation-free: recycle packet objects via a free list.
// A packet is only returned to the pool once its owning frame falls off the
// ring, so no live frame is ever mutated — scrubber history stays immutable.
acquirePacket_() {
  return this.freeList_.pop() || makePacket(); // only allocates when pool runs dry
}

releasePackets_(arr) {
  for (const p of arr) this.freeList_.push(p);
}

  frames() {
    const out = [];
    for (let i = 0; i < this.length; i++) {
      out.push(this.frames_[(this.write_ - this.length + i + this.capacity) % this.capacity]);
    }
    return out;
  }

  currentFrame() {
    return this.length ? this.frames_[this.write_ === 0 ? this.capacity - 1 : this.write_ - 1] : null;
  }

  ingest(wsFrame) {
    if (!wsFrame) return;
    if (wsFrame.algorithm) this.setAlgorithm(wsFrame.algorithm);
    // the broadcaster re-sends the whole ring each tick: keep only fresh ones
    const fresh = (wsFrame.decisions || []).filter((d) => d.ts_ms > this.lastSeenTs);
    if (fresh.length) {
      fresh.sort((a, b) => a.ts_ms - b.ts_ms);
      this.lastSeenTs = fresh[fresh.length - 1].ts_ms;
    }

    for (let i = 0; i < SUB_FRAMES_PER_TICK; i++) {
      this.emitFrame_(fresh, i);
    }
  }

  emitFrame_(fresh, sub) {
    // spread the tick's fresh decisions evenly: decision i lands in
    // sub-frame floor(i * SUB_FRAMES_PER_TICK / n). For n=5 that's one per
    // frame; for n=1 the single decision goes to frame 0.
    const n = fresh.length;
    const slice = [];
    for (let i = 0; i < n; i++) {
      if (Math.floor((i * SUB_FRAMES_PER_TICK) / n) === sub) slice.push(fresh[i]);
    }

    // track logical in-flight packets (never mutated after a frame snapshots them)
    for (const d of slice) {
      this.inFlight_.push({
        srcIp: d.vip,
        botId: botIdFor(d.vip),
        status: d.allowed ? "ALLOWED" : "DROPPED",
        spawnStep: this.stepIndex,
      });
    }
    // drop finished packets (older than flightFrames)
    this.inFlight_ = this.inFlight_.filter(
      (lp) => this.stepIndex - lp.spawnStep < this.flightFrames
    );

    const frame = this.frames_[this.write_];
    // the ring is about to overwrite this slot — give its old packets back to
    // the pool (safe: the slot is the oldest, already past the read window)
    if (this.length === this.capacity) this.releasePackets_(frame.activePackets);
    frame.stepIndex = this.stepIndex;
    frame.timestampMs = this.stepIndex * FRAME_MS;
    frame.activeAlgorithm = this.activeAlgorithm;
    // last decision of this sub-frame (or carry the running state forward)
    const last = slice[slice.length - 1];
    frame.algorithmMetrics = {
      tokensRemaining: last && last.tokens !== undefined ? last.tokens : 0,
      windowRate: last ? last.window_count : 0,
    };
    // materialize pooled packet objects with computed progress — every frame
    // owns its own copies, so historical frames stay immutable for the scrubber
    frame.activePackets = this.inFlight_.map((lp) => {
      const p = this.acquirePacket_();
      p.srcIp = lp.srcIp;
      p.botId = lp.botId;
      p.status = lp.status;
      p.progress = (this.stepIndex - lp.spawnStep) / this.flightFrames;
      return p;
    });
    frame.explanationText = explain(frame, this.rateLimitMaxRps);

    this.write_ = (this.write_ + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
    this.stepIndex++;
  }
}
