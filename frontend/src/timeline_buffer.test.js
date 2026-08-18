import { describe, it, expect } from "vitest";
import { TimelineBuffer, FRAME_MS, SUB_FRAMES_PER_TICK } from "./timeline_buffer.js";

function tick(decisions = [], algorithm = "token_bucket") {
  return { ts: 1, normal_rps: 0, attack_rps: 0, blocked_rps: 0, algorithm, decisions };
}

function decision(over = {}) {
  return { vip: "10.0.0.5", allowed: false, ts_ms: 100, tokens: 0, window_count: 0, ...over };
}

describe("TimelineBuffer basics", () => {
  it("emits SUB_FRAMES_PER_TICK frames per ingested tick", () => {
    const b = new TimelineBuffer();
    b.ingest(tick());
    expect(b.frames()).toHaveLength(SUB_FRAMES_PER_TICK);
  });

  it("steps stepIndex and timestampMs at 100ms per frame", () => {
    const b = new TimelineBuffer();
    b.ingest(tick());
    b.ingest(tick());
    const f = b.frames();
    expect(f[0].stepIndex).toBe(0);
    expect(f[0].timestampMs).toBe(0);
    expect(f[5].stepIndex).toBe(5);
    expect(f[5].timestampMs).toBe(5 * FRAME_MS);
  });

  it("length is capped at capacity and oldest frames fall off", () => {
    const b = new TimelineBuffer({ capacity: 10 });
    for (let i = 0; i < 10; i++) b.ingest(tick()); // 50 frames emitted
    expect(b.length).toBe(10);
    b.ingest(tick()); // 55 frames; only the last 10 (stepIndex 45..54) survive
    expect(b.length).toBe(10);
    expect(b.frames()[0].stepIndex).toBe(45);
  });

  it("currentFrame returns the newest frame", () => {
    const b = new TimelineBuffer();
    b.ingest(tick());
    const last = b.frames()[b.length - 1];
    expect(b.currentFrame()).toBe(last);
  });

  it("liveStepIndex tracks the newest emitted frame and is null when empty", () => {
    const b = new TimelineBuffer();
    expect(b.liveStepIndex()).toBeNull();
    b.ingest(tick()); // emits SUB_FRAMES_PER_TICK frames (5)
    expect(b.liveStepIndex()).toBe(SUB_FRAMES_PER_TICK - 1);
    b.ingest(tick());
    expect(b.liveStepIndex()).toBe(2 * SUB_FRAMES_PER_TICK - 1);
  });

  it("clear resets everything", () => {
    const b = new TimelineBuffer();
    b.ingest(tick());
    b.clear();
    expect(b.length).toBe(0);
    expect(b.currentFrame()).toBeNull();
  });

  it("dedupes decisions by ts_ms across ticks", () => {
    const b = new TimelineBuffer();
    b.ingest(tick([decision({ ts_ms: 100 })]));
    b.ingest(tick([decision({ ts_ms: 100 }), decision({ ts_ms: 300 })]));
    // count spawns (progress 0), not in-flight appearances
    const spawns = b.frames().flatMap((f) => f.activePackets).filter((p) => p.progress === 0);
    expect(spawns.filter((p) => p.srcIp === "10.0.0.5")).toHaveLength(2);
  });

  it("recovers from an engine restart when ts_ms resets below the watermark", () => {
    const b = new TimelineBuffer();
    b.ingest(tick([decision({ ts_ms: 5000 })])); // old engine process watermark
    const before = b.frames().flatMap((f) => f.activePackets).filter((p) => p.progress === 0).length;
    expect(before).toBe(1);

    // a fresh ddos_server process: its steady clock starts near 0 again, so the
    // tick lands below the old watermark and must still spawn, not be skipped
    b.ingest(tick([decision({ ts_ms: 120 })]));
    const after = b.frames().flatMap((f) => f.activePackets).filter((p) => p.progress === 0).length;
    expect(after).toBe(2);
  });

  it("never mutates pooled packets of a frame still in the read window", () => {
    const b = new TimelineBuffer({ capacity: 10 });
    // two ticks fill the ring (10 frames, stepIndex 0..9)
    b.ingest(tick([decision({ ts_ms: 100 })]));
    b.ingest(tick([decision({ ts_ms: 200 })]));
    const survivor = b.frames()[5]; // stepIndex 5: survives the next tick's eviction
    const packetRef = survivor.activePackets[0];
    const progress = packetRef.progress;
    const count = survivor.activePackets.length;

    b.ingest(tick([decision({ ts_ms: 300 })])); // overflow: evicts stepIndex 0..4

    expect(b.frames()[0]).toBe(survivor); // still the head of the read window
    expect(survivor.activePackets.length).toBe(count);
    expect(survivor.activePackets[0]).toBe(packetRef); // same pooled object
    expect(survivor.activePackets[0].progress).toBe(progress); // unmutated
  });

  it("records activeAlgorithm from the tick or setAlgorithm", () => {
    const b = new TimelineBuffer();
    b.ingest(tick([], "sliding_window"));
    expect(b.frames()[0].activeAlgorithm).toBe("sliding_window");
  });
});

describe("TimelineBuffer algorithm state", () => {
  it("carries tokensRemaining for token bucket decisions", () => {
    const b = new TimelineBuffer();
    b.setAlgorithm("token_bucket");
    b.ingest(tick([decision({ allowed: false, tokens: 0, ts_ms: 100 })]));
    const f = b.frames()[0];
    expect(f.algorithmMetrics.tokensRemaining).toBe(0);
    expect(f.activePackets[0].status).toBe("DROPPED");
  });

  it("carries windowRate for sliding window decisions", () => {
    const b = new TimelineBuffer();
    b.setAlgorithm("sliding_window");
    b.ingest(tick([decision({ allowed: true, window_count: 3, ts_ms: 100 })]));
    const f = b.frames()[0];
    expect(f.algorithmMetrics.windowRate).toBe(3);
    expect(f.activePackets[0].status).toBe("ALLOWED");
  });

  it("models packet flight: progress advances across FLIGHT_FRAMES", () => {
    const b = new TimelineBuffer({ flightFrames: 4 });
    b.ingest(tick([decision({ allowed: true, ts_ms: 100 })]));
    const frames = b.frames();
    const progs = frames.map((f) =>
      f.activePackets.find((p) => p.srcIp === "10.0.0.5")?.progress
    );
    expect(progs[0]).toBe(0);
    expect(progs[1]).toBeCloseTo(1 / 4, 5);
    expect(progs[3]).toBeCloseTo(3 / 4, 5);
    expect(progs[4]).toBeUndefined(); // flight ends after 4 frames
  });

  it("buckets decisions across the 5 sub-frames of a tick", () => {
    const b = new TimelineBuffer();
    const ds = [100, 200, 300, 400, 500].map((ts_ms) => decision({ ts_ms }));
    b.ingest(tick(ds));
    // count fresh spawns (progress 0) per frame — in-flight packets carry over
    const counts = b.frames().map((f) => f.activePackets.filter((p) => p.progress === 0).length);
    expect(counts).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("TimelineBuffer explanation text", () => {
  it("explains a dropped packet with token bucket state", () => {
    const b = new TimelineBuffer();
    b.setAlgorithm("token_bucket");
    b.ingest(tick([decision({ allowed: false, tokens: 0, ts_ms: 100 })]));
    const text = b.frames()[0].explanationText;
    expect(text).toContain("10.0.0.5");
    expect(text).toContain("Token Bucket empty");
    expect(text).toContain("DROPPED");
  });

  it("explains an allowed packet", () => {
    const b = new TimelineBuffer();
    b.setAlgorithm("token_bucket");
    b.ingest(tick([decision({ allowed: true, tokens: 1, ts_ms: 100 })]));
    expect(b.frames()[0].explanationText).toContain("ALLOWED");
  });
});
