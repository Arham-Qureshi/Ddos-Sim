# DESIGN.md — WATCHTOWER Console

> A dark security-ops console: monitor, don't decorate. Status colors are data encoding, not accents. Motion earns its place or it doesn't ship.

## 1. Visual Theme & Atmosphere

**Style**: Dark Tech Ops Console
**Keywords**: terminal, data-dense, off-black, status-neon, mono, live telemetry, restrained glow
**Tone**: Calm and precise — NOT playful, NOT cyberpunk, NOT glassy.
**Feel**: Like a clean network-operations desk at night: near-black surfaces, hairline slate rules, and four status hues that only ever mean something.

**Composition**: the threat map is an orbit scene — target server centered with the shield ring, bots on an outer ring, attacker host in the bottom-left corner.

**Interaction Tier**: L2 (fluid live-motion for telemetry; everything else static until hovered).
**Dependencies**: PixiJS 7.4.3 (vendored WebGL, canvas surface only) + GSAP (vendored, bot fan-out only). No new deps.

## 2. Color Palette & Roles

```css
:root {
  /* Surfaces */
  --bg: #0a0e14;                 /* page background (deep navy off-black, never pure #000) */
  --panel: #0f1520;              /* sidebar / cards */
  --panel-2: #131b29;            /* alternate surface */
  --line: rgba(148, 163, 184, 0.12);  /* hairline borders, slate */
  --line-strong: rgba(148, 163, 184, 0.35);

  /* Text */
  --muted: #7c8aa0;              /* tertiary, labels, hints */
  --txt: #cbd5e1;                /* body */
  --txt-bright: #f1f5f9;         /* emphasized */

  /* Semantic status hues — DATA ENCODING, never decorative */
  --normal: #38bdf8;             /* cyan: normal / allowed traffic / target */
  --attack: #f59e0b;             /* amber: attack / bot nodes */
  --blocked: #fb7185;            /* rose: blocked / dropped packets */
  --shield: #34d399;             /* emerald: mitigation shield */
  --neutral: #64748b;            /* slate: host node, links, idle elements */

  /* RGB variants for rgba() */
  --normal-rgb: 56, 189, 248;
  --attack-rgb: 245, 158, 11;
  --blocked-rgb: 251, 113, 133;
  --shield-rgb: 52, 211, 153;
}
```

**Color Rules:**
- All colors are referenced as the semantic tokens above; no hardcoded hex in components or the Pixi scene. The renderer maps each token to its 0x value exactly once.
- The four status hues are reserved for data meaning (allowed / attack / blocked / shield). They are never used as decorative accents.
- Saturation is kept under control: use the listed hues, not brighter variants, and never stack multiple glow layers on one element.

## 3. Typography Rules

**Font Stack:** `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` — the whole console is mono; there are no display serifs or brand faces.

| Role | Size | Weight | Tracking | Notes |
|------|------|--------|----------|-------|
| Panel/section heading | 11px | 600 | 0.1em uppercase | sentence-case labels preferred over all-caps stacks |
| Body / values | 12-13px | 400 | normal | slate-300 |
| Labels / hints | 11px | 400 | normal | `--muted` |
| HUD numbers | 12px | 500 | normal | zero-padded (`0012`) for tabular alignment |
| Numeric telemetry | 14px | 500 | normal | mono, tabular via zero-pad |

**Typography Rules:**
- Sentence case everywhere. No TITLE CASE headers.
- All numbers in mono, zero-padded where they change width so columns don't jitter.
- **NEVER use**: Inter as a default, any display serif, or emoji glyphs in UI copy (status is conveyed by the semantic hues + mono text).

## 4. Component Stylings

### Buttons
- **default**: `border` 1px `--line-strong`-tinted per role; `background` panel tint; mono 10-12px uppercase tracking-widest; text in role hue (cyan/rose/emerald/amber per intent).
- **hover**: brighten border to the role hue, background lifts one step.
- **active**: `scale(0.98)` / `translateY(1px)` press feedback.
- **focus**: visible 2px outline in `--attack` (existing `.btn-focus`), never removed.
- **disabled**: 40% opacity, `cursor-not-allowed`, no hover.

### Tabs (command-center / threat-map)
- Active tab: `--txt-bright` + underline/border in `--normal`; inactive: `--muted`. Hover brightens text. Focus ring required.

### Selects / sliders
- Slider track `--panel-2`, thumb in the role hue; label above value, value in mono.
- Select styled as a button-like control with a visible focus ring.

### Toasts / status
- Transient toasts, bottom-left, mono 11px, `--panel` bg + `--line` border; dismiss on timeout. No exclamation marks in copy.

### Legend (threat map)
- Four entries, each a role-hue dot + mono label: allowed / dropped / shield / bots. Static, low-contrast (slate text, hue only on the dot).

### Threat-map HUD (on-canvas)
- Top-right: a single mono status line — `SHIELD ON · 6 rps` (emerald) / `SHIELD OFF`. Zero-padded values, AA contrast on `--bg`. The allowed/blocked counters live in the instrument strip, not on the canvas.

### Threat banner (instrument strip)
- A status bar under the canvas: dot + `NOMINAL / ELEVATED / SEVERE` (cyan / amber / rose) + one-line reason ("blocked 40 rps — attack in progress"). Level derives from blocked rate vs the rate cap — judgment first, always honest.

### Per-bot panels (instrument strip)
- One mono panel per bot: `BOT 01`, `sent 41`, `blocked 40`, and a block-rate bar. Hover a panel highlights that bot on canvas; hovering the canvas bot highlights its panel (two-way link). Blocked rate shown as a filled bar, rose on the blocked hue.

### Sparklines (instrument strip)
- Hand-rolled mini canvases (~120x32), 60s window of attack / blocked rps. Mono-styled thin stroke, no fill, no grid. Drawn only with real telemetry.

### Tooltip (on-canvas)
- `--panel` bg, `--line` border, mono 10px, e.g. `10.0.0.5 · 32 sent · 4 blocked`. Hover to show, hide on leave. Appears on the hovered bot, clamped inside the canvas.

## 5. Layout Principles

- Shell: left admin sidebar (fixed width) + main content in a dual-tab shell (Ticket 9). Main panel `min-w-0 flex-1`.
- Threat-map canvas: `w-full h-[340px]`, `display:block`; all sizing from CSS, never inline (Pixi `autoDensity` stays off; backing store scales with devicePixelRatio).
- Spacing scale: `4/8/12/16/24` px; component gaps 8-12px; control rows `mt-3`.
- Grid over flex-math: use Tailwind grid utilities; no percentage-width flex hacks.

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | no shadow | panels, cards (hairline border only) |
| Glow (data) | additive blend, alpha ≤ 0.9 | arc packet heads + trails, shield ring, impact/arrival ripples, node halos |
| Hover lift | border brightens, bg lifts | interactive controls |

**Rules:** glows are **tinted** to the semantic hue and **alpha-capped** (≤ 0.9); never pure-white bloom. No drop shadows on light or pure-black shadows anywhere. The canvas backdrop is a faint radial cyan vignette + dot grid, `alpha ≈ 0.05`, so it reads as depth, not decoration.

## 7. Animation & Interaction

**Motion Philosophy**: Live telemetry moves continuously and smoothly; chrome never animates just to exist.

**Tier**: L2.

- **Particle flight**: packets travel curved **arcs** (bezier bowed outward from the target), eased along the curve at 60fps via a live-edge playhead (never racing ahead of the frame stream). Each packet renders as a **glowing head** + a short **fading trail** (4 pooled dots), a **muzzle flash** on launch, and an **impact ripple** on arrival — dropped packets shatter, allowed ones pulse.
- **Radar sweep**: a faint sweep line rotates (~8s/rev) from the target as the "system alive" heartbeat; it freezes when the engine goes dark, the tab hides, or reduced motion is on.
- **Threat-colored ambient**: a barely-there full-canvas tint (alpha ≈ 0.04) recolored cyan → amber → rose as blocked rate climbs — judgment at a glance, rebuilt only when the level changes.
- **Bot fan-out**: GSAP `back.out(1.4)`, 0.6s, 30ms stagger (existing Ticket 10 tweens) on attack start; `power1.in` collapse on stop.
- **Shield**: subtle pulse (1.2s sine) with intensity scaling to blocked rate; rotating dashed ring while mitigation is on. On a blocked impact: a quick ring flash + shatter burst, once per packet.
- **Node activity**: a bot lights a brief ring when it sends; allowed arrivals ripple at the target.
- **HUD/tooltips**: static (no entrance animation) — content, not spectacle.

### Reduced Motion (mandatory)
`@media (prefers-reduced-motion: reduce)` / renderer `reduceMotion: true`:
- No continuous glide: packets render at their integer-step positions, on the straight line (no arcs).
- No trails, muzzle flashes, ripples, shield pulse/rotation, or radar sweep.
- GSAP fan-out jumps instantly to the final layout.
- Live ticker still updates on new frames (data freshness is not "motion").

## 8. Do's and Don'ts

### Do
- Use the four status hues strictly for data meaning; keep everything else slate.
- Show numbers in mono, zero-padded, with the units (rps, s).
- Let the data drive the scene: an idle map is a quiet map.
- Keep the fallback (no WebGL) a degraded, honest 2D map — never a broken canvas.
- Honor `prefers-reduced-motion`; data keeps updating, effects drop.

### Don't
- ❌ Pure `#000000` or pure `#ffffff` anywhere — surfaces stay in the navy-slate family.
- ❌ Emoji or icon glyphs in HUD/tooltip/legend copy — status is hue + mono text.
- ❌ Neon stacking: more than one glow layer per element, or brightness above the token hues.
- ❌ Fake precision — show real engine values (rps, tokens, counts), never invented numbers.
- ❌ `Inter` as the font, or any serif, or all-caps-everywhere — the console is one mono stack.
- ❌ Motion without meaning (spinny decorations, idle pulses on static elements).
- ❌ Frames/particles snapping — live playback must hold at the data edge, never jump back.
- ❌ Hardcoded hex in components — every color is a token reference.

## 9. Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| Desktop (> 1024px) | Sidebar + tabs layout; canvas `h-[340px]` |
| Tablet (≤ 1024px) | Sidebar collapses to a narrower column; canvas keeps `h-[340px]` |
| Mobile (≤ 640px) | Sidebar stacks above main; canvas `h-[260px]`; HUD text shrinks to 11px |

**Touch Targets:** ≥ 36px for interactive chrome (44px preferred); tooltips are hover-only (desktop), never a primary control.
**Collapsing Strategy:** the threat-map canvas is `w-full` at every breakpoint; `resize()` re-reads `clientWidth/clientHeight`, rebuilds the topology, re-anchors the HUD to the top-right, and re-fits the backdrop. Never letterbox.