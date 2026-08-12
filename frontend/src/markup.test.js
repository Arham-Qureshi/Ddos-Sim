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