// threat_stats.test.js — pure counters powering the threat-map HUD + tooltips.
import { describe, it, expect } from "vitest";
import { emptyStats, addPackets, statsFromFrames } from "./threat_stats.js";

describe("threat_stats", () => {
  it("emptyStats starts at zero", () => {
    const s = emptyStats();
    expect(s.allowed).toBe(0);
    expect(s.blocked).toBe(0);
    expect(s.byBot.size).toBe(0);
  });

  it("addPackets counts statuses and per-bot totals", () => {
    const s = addPackets(emptyStats(), [
      { botId: 1, status: "ALLOWED" },
      { botId: 1, status: "DROPPED" },
      { botId: 2, status: "ALLOWED" },
    ]);
    expect(s.allowed).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.byBot.get(1)).toEqual({ sent: 2, blocked: 1 });
    expect(s.byBot.get(2)).toEqual({ sent: 1, blocked: 0 });
  });

  it("addPackets does not mutate its input stats (returns a copy)", () => {
    const before = emptyStats();
    addPackets(before, [{ botId: 1, status: "ALLOWED" }]);
    expect(before.allowed).toBe(0);
    expect(before.byBot.size).toBe(0);
  });

  it("statsFromFrames folds a window of frames", () => {
    const s = statsFromFrames([
      { activePackets: [{ botId: 1, status: "ALLOWED" }] },
      { activePackets: [{ botId: 1, status: "DROPPED" }, { botId: 2, status: "ALLOWED" }] },
    ]);
    expect(s.allowed).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.byBot.get(1)).toEqual({ sent: 2, blocked: 1 });
  });

  it("statsFromFrames tolerates frames without packets and no frames at all", () => {
    expect(statsFromFrames([]).allowed).toBe(0);
    expect(statsFromFrames([{}, { activePackets: null }]).blocked).toBe(0);
  });
});