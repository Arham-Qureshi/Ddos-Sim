// scrubber_controls.js — AlgoMaster-style playback bar for the t13 threat map.
// Owns the DOM controls and a 60fps sync loop; playback state itself lives in
// the renderer facade (setPlayhead / setPlayback / getPlayhead) so there is
// exactly one clock owner. Scrubbing pauses; LIVE reattaches at the live edge.

import { pickFrame } from "./particles.js";

export function initScrubber({ els, timeline, threatMap, gsap = null, reduceMotion = false } = {}) {
  let playing = true;
  let speed = 1;
  let visible = true;
  let lastBanner = null;
  const speedBtns = [...els.scrubSpeed.querySelectorAll("[data-speed]")];

  function renderPlay() {
    els.scrubPlay.textContent = playing ? "Pause" : "Play";
    els.scrubPlay.classList.toggle("scrub-on", playing);
  }

  function renderSpeeds() {
    speedBtns.forEach((b) => b.classList.toggle("scrub-on", Number(b.dataset.speed) === speed));
  }

  function pause() {
    playing = false;
    threatMap.setPlayback({ playing: false });
    renderPlay();
  }

  function play() {
    playing = true;
    threatMap.setPlayback({ playing: true });
    renderPlay();
  }

  function showBanner(text) {
    if (text === lastBanner) return;
    lastBanner = text;
    if (reduceMotion || !gsap) {
      els.scrubBanner.textContent = text;
      return;
    }
    const set = () => {
      els.scrubBanner.textContent = text;
      gsap.fromTo(els.scrubBanner, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" });
    };
    if (els.scrubBanner.textContent) {
      gsap.to(els.scrubBanner, { opacity: 0, duration: 0.15, onComplete: set });
    } else {
      set();
    }
  }

  function disableControls() {
    els.scrubPrev.disabled = els.scrubNext.disabled = true;
    els.scrubPlay.disabled = true;
    els.scrubLive.disabled = true;
    els.scrubRange.disabled = true;
    speedBtns.forEach((b) => { b.disabled = true; });
    els.scrubFrame.textContent = "frame — / —";
    showBanner("no data yet");
  }

  function enableControls() {
    els.scrubPrev.disabled = els.scrubNext.disabled = false;
    els.scrubPlay.disabled = false;
    els.scrubLive.disabled = false;
    els.scrubRange.disabled = false;
    speedBtns.forEach((b) => { b.disabled = false; });
  }

  // one sync step; runs on rAF, exported so tests can drive it directly
  function step() {
    const live = timeline.liveStepIndex();
    if (live == null) {
      disableControls();
      return;
    }
    enableControls();
    const ph = threatMap.getPlayhead();
    const liveInt = Math.floor(live);
    els.scrubRange.max = String(liveInt);
    els.scrubRange.value = String(Math.min(Math.floor(ph), liveInt));
    const f = pickFrame(timeline.frames(), ph);
    if (f) {
      els.scrubFrame.textContent = `frame ${f.stepIndex} / ${liveInt} · ${(f.timestampMs / 1000).toFixed(1)}s`;
      showBanner(f.explanationText);
    }
    els.scrubLive.classList.toggle("scrub-behind", Math.floor(ph) < liveInt);
  }

  function loop() {
    if (visible) step();
    requestAnimationFrame(loop);
  }

  els.scrubPrev.addEventListener("click", () => {
    pause();
    threatMap.setPlayhead(Math.max(0, Math.floor(threatMap.getPlayhead()) - 1));
  });
  els.scrubNext.addEventListener("click", () => {
    pause();
    threatMap.setPlayhead(Math.floor(threatMap.getPlayhead()) + 1);
  });
  els.scrubPlay.addEventListener("click", () => (playing ? pause() : play()));
  els.scrubRange.addEventListener("input", () => {
    pause();
    threatMap.setPlayhead(Number(els.scrubRange.value));
  });
  els.scrubLive.addEventListener("click", () => {
    playing = true;
    threatMap.setPlayback({ playing: true });
    const live = timeline.liveStepIndex();
    if (live != null) threatMap.setPlayhead(live);
    renderPlay();
  });
  speedBtns.forEach((b) =>
    b.addEventListener("click", () => {
      speed = Number(b.dataset.speed) || 1;
      threatMap.setPlayback({ playing, speed });
      renderSpeeds();
    })
  );

  function setVisible(on) {
    visible = !!on;
  }

  // bound the slider up front so it is usable before the first sync tick
  const initialLive = timeline.liveStepIndex();
  if (initialLive != null) els.scrubRange.max = String(initialLive);

  renderPlay();
  renderSpeeds();
  requestAnimationFrame(loop);
  return { setVisible, step };
}