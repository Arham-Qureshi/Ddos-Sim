import { describe, it, expect, vi, beforeEach } from "vitest";
import { initScrubber } from "./scrubber_controls.js";
import { FRAME_MS } from "./timeline_buffer.js";

function makeEls() {
  const btn = (text = "") => {
    const b = document.createElement("button");
    b.textContent = text;
    b.disabled = false;
    return b;
  };
  const scrubSpeed = document.createElement("span");
  for (const s of ["0.5", "1", "2"]) {
    const b = document.createElement("button");
    b.dataset.speed = s;
    b.textContent = `${s}x`;
    scrubSpeed.appendChild(b);
  }
  return {
    scrubPrev: btn("◀"),
    scrubPlay: btn("Pause"),
    scrubNext: btn("▶"),
    scrubFrame: document.createElement("span"),
    scrubRange: Object.assign(document.createElement("input"), { type: "range", min: "0", max: "0", value: "0" }),
    scrubSpeed,
    scrubLive: btn("Live"),
    scrubBanner: document.createElement("p"),
  };
}

function makeTimeline(frames) {
  return { frames: () => frames, liveStepIndex: () => (frames.length ? frames[frames.length - 1].stepIndex : null) };
}

function makeMap() {
  const calls = { playhead: 0, playback: [] };
  return {
    getPlayhead: () => calls.playhead,
    setPlayhead: (s) => { calls.playhead = s; },
    setPlayback: (p) => { calls.playback.push(p); },
    calls,
  };
}

const frames = Array.from({ length: 10 }, (_, i) => ({
  stepIndex: i,
  timestampMs: i * FRAME_MS,
  explanationText: `Frame ${i}: nothing.`,
  activePackets: [],
}));

describe("initScrubber", () => {
  let els, map, gsap;
  beforeEach(() => {
    els = makeEls();
    map = makeMap();
    gsap = { to: vi.fn(), fromTo: vi.fn() };
  });

  function boot() {
    return initScrubber({ els, timeline: makeTimeline(frames), threatMap: map, gsap });
  }

  it("disables controls and shows no-data on an empty buffer", () => {
    initScrubber({ els, timeline: makeTimeline([]), threatMap: map, gsap }).step();
    expect(els.scrubPlay.disabled).toBe(true);
    expect(els.scrubRange.disabled).toBe(true);
    expect(els.scrubBanner.textContent).toBe("no data yet");
  });

  it("step forward pauses and advances exactly one frame", () => {
    const scrubber = boot();
    map.calls.playhead = 3;
    els.scrubNext.dispatchEvent(new Event("click"));
    expect(map.calls.playback.at(-1)).toEqual({ playing: false });
    expect(map.calls.playhead).toBe(4);
    scrubber.step();
    expect(els.scrubFrame.textContent).toContain("frame 4 / 9");
  });

  it("step back clamps at zero", () => {
    boot();
    map.calls.playhead = 0;
    els.scrubPrev.dispatchEvent(new Event("click"));
    expect(map.calls.playhead).toBe(0);
  });

  it("play toggle flips playback state", () => {
    const scrubber = boot();
    els.scrubPlay.dispatchEvent(new Event("click"));
    expect(map.calls.playback.at(-1)).toEqual({ playing: false }); // was playing
    els.scrubPlay.dispatchEvent(new Event("click"));
    expect(map.calls.playback.at(-1)).toEqual({ playing: true });
    scrubber.step();
  });

  it("speed buttons send the selected speed", () => {
    boot();
    els.scrubSpeed.querySelector('[data-speed="0.5"]').dispatchEvent(new Event("click"));
    expect(map.calls.playback.at(-1)).toEqual({ playing: true, speed: 0.5 });
  });

  it("slider scrubbing pauses and jumps the playhead", () => {
    boot();
    els.scrubRange.value = "6";
    els.scrubRange.dispatchEvent(new Event("input"));
    expect(map.calls.playback.at(-1)).toEqual({ playing: false });
    expect(map.calls.playhead).toBe(6);
  });

  it("LIVE resumes playing at the live edge", () => {
    boot();
    map.calls.playhead = 2;
    els.scrubLive.dispatchEvent(new Event("click"));
    expect(map.calls.playhead).toBe(9); // liveStepIndex
    expect(map.calls.playback.at(-1)).toEqual({ playing: true });
  });

  it("sync step fills counter and banner from the current frame", () => {
    const scrubber = boot();
    map.calls.playhead = 5;
    scrubber.step();
    expect(els.scrubFrame.textContent).toContain("frame 5 / 9");
    expect(els.scrubBanner.textContent).toBe("Frame 5: nothing.");
  });
});