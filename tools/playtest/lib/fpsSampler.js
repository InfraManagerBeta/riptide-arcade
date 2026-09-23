// FPS sampler. Installed into the PAGE via page.addInitScript (never by
// editing the template) so it re-installs itself fresh on every navigation
// (probe run and exploratory run each get their own clean series). Samples
// come from real requestAnimationFrame timestamps, independent of the
// template/game code entirely.
'use strict';

// NOTE: this function is serialized and evaluated INSIDE the browser page by
// Playwright — it must not close over anything from the Node scope.
function installFpsSampler() {
  window.__playtestFps = [];
  let last = null;
  function loop(ts) {
    if (last !== null) {
      const dt = ts - last;
      if (dt > 0) window.__playtestFps.push(1000 / dt);
    }
    last = ts;
    window.requestAnimationFrame(loop);
  }
  window.requestAnimationFrame(loop);
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// fpsStats(series) -> { count, min, median, mean, p5 } (nulls when empty)
function fpsStats(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return { count: 0, min: null, median: null, mean: null, p5: null };
  }
  const sorted = [...series].sort((a, b) => a - b);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  return {
    count: series.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    mean,
    p5: percentile(sorted, 0.05),
  };
}

module.exports = { installFpsSampler, fpsStats };
