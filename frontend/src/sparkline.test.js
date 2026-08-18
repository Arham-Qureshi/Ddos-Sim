// sparkline.test.js — draws a normalized polyline on a 2D context.
import { describe, it, expect, vi } from "vitest";
import { drawSparkline } from "./sparkline.js";

function makeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: "",
    lineWidth: 0,
  };
}

describe("drawSparkline", () => {
  it("is a safe no-op without a context", () => {
    expect(() => drawSparkline(null, [1, 2, 3])).not.toThrow();
  });

  it("clears and never strokes with fewer than 2 points", () => {
    const ctx = makeCtx();
    drawSparkline(ctx, []);
    drawSparkline(ctx, [5]);
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it("strokes a normalized polyline", () => {
    const ctx = makeCtx();
    drawSparkline(ctx, [2, 4, 8], { width: 120, height: 32, color: "#38bdf8", stroke: 1 });
    expect(ctx.strokeStyle).toBe("#38bdf8");
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.moveTo).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it("draws the peak at the top of the box", () => {
    const ctx = makeCtx();
    drawSparkline(ctx, [1, 10], { width: 120, height: 32 });
    const peak = ctx.lineTo.mock.calls[0];
    expect(peak[1]).toBeCloseTo(2, 3); // 32 - 2 - (10/10)*28
    const valley = ctx.moveTo.mock.calls[0];
    expect(valley[1]).toBeCloseTo(32 - 2 - 0.1 * 28, 3);
  });

  it("does not divide by zero on a flat series", () => {
    const ctx = makeCtx();
    expect(() => drawSparkline(ctx, [0, 0, 0], { width: 120, height: 32 })).not.toThrow();
  });
});