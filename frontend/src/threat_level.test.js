// threat_level.test.js — thresholds and semantic hues for the threat banner.
import { describe, it, expect } from "vitest";
import { threatLevel } from "./threat_level.js";

describe("threatLevel", () => {
  it("is nominal when nothing is blocked", () => {
    expect(threatLevel(0).level).toBe("nominal");
    expect(threatLevel(null).level).toBe("nominal");
  });

  it("is elevated below cap*2", () => {
    expect(threatLevel(2, 2).level).toBe("elevated");
    expect(threatLevel(3.4, 2).level).toBe("elevated");
  });

  it("is severe at/above cap*2", () => {
    expect(threatLevel(4, 2).level).toBe("severe");
    expect(threatLevel(40, 2).level).toBe("severe");
  });

  it("colors map to the semantic hues", () => {
    expect(threatLevel(0).color).toBe(0x38bdf8); // normal cyan
    expect(threatLevel(2, 2).color).toBe(0xf59e0b); // attack amber
    expect(threatLevel(9, 2).color).toBe(0xfb7185); // blocked rose
  });

  it("detail mentions the blocked rate for severe", () => {
    expect(threatLevel(40, 2).detail).toMatch(/40/);
  });
});