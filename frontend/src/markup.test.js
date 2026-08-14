import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// guard against the vendored tailwind v2 build silently dropping arbitrary
// utility classes (e.g. `.h-[340px]` -> chart div 0px tall, echarts draws
// nothing). standard utilities are covered by the broader purge build; the
// arbitrary values need the JIT this vendored css does not have.
const root = join(import.meta.dirname, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const tailwind = readFileSync(join(root, "vendor", "tailwind.min.css"), "utf8");
const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const css = `${tailwind}\n${inline}`;

// tailwind escapes special characters when emitting class selectors
const esc = (s) => s.replace(/[#[\]./]/g, (c) => `\\${c}`);

const arbitrary = [...html.matchAll(/class="([^"]+)"/g)]
  .flatMap((m) => m[1].split(/\s+/))
  .filter((c) => c.includes("["));

describe("index.html arbitrary utility classes", () => {
  it("every arbitrary-value class token has a matching css rule", () => {
    const missing = arbitrary.filter((c) => !css.includes(`.${esc(c)}`));
    expect(missing).toEqual([]);
  });
});

describe("index.html dual-tab shell", () => {
  it("has a tab bar with both tab buttons", () => {
    expect(html).toContain('data-tab="threat-map"');
    expect(html).toContain('data-tab="command-center"');
  });

  it("has both tab panels wired by data attribute", () => {
    expect(html).toContain('id="threat-map-tab" data-tab-panel="threat-map"');
    expect(html).toContain('id="command-center-tab" data-tab-panel="command-center"');
  });

  it("still loads echarts", () => {
    expect(html).toContain("vendor/echarts.min.js");
  });

  it("styles the active tab button", () => {
    const css = `${tailwind}\n${inline}`;
    expect(css).toMatch(/\.tab-btn\.active\s*\{/);
  });
});

describe("index.html admin sidebar (Ticket 8)", () => {
  it("has the persistent sidebar with all six controls", () => {
    expect(html).toContain('id="admin-sidebar"');
    for (const id of ["baseline-toggle", "bot-count", "attack-rps",
                      "attack-duration", "algorithm-select", "emergency-stop"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("removed the old header control buttons", () => {
    // controls moved into the sidebar: header must not duplicate launch
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).not.toContain("launch-attack");
  });

  it("bot count and rps sliders respect the sidebar caps", () => {
    expect(html).toMatch(/id="bot-count"[^>]*min="1" max="32"/);
    expect(html).toMatch(/id="attack-rps"[^>]*min="10" max="200"/);
    expect(html).toMatch(/id="attack-duration"[^>]*min="5" max="60"/);
  });
});