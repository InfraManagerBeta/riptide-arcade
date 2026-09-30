// Bounded, seeded exploratory session: "random-ish action mashing" from the
// canonical action set, reproducible for a given --seed.
//
// The DECISION SEQUENCE (which action, pressed/released, how long to wait
// before the next decision) is planned up front by a pure function of
// (seed, steps, intervalMin, intervalMax) alone — it never reads back live
// game/page state. That is what makes `--seed N` reproducible byte-for-byte
// regardless of any real-world timing jitter (screenshot latency, CI
// slowness, ...): two runs with the same seed always PLAN the identical
// sequence, even though the resulting on-page gameplay can differ slightly
// with real-time noise.
'use strict';

const { createRng } = require('./prng');

const CANONICAL_ACTIONS = ['left', 'right', 'up', 'down', 'primary', 'pause'];
// Weighted so movement dominates, `primary` fires often enough to serve from
// MENU and restart from GAME_OVER whenever the session happens to be there,
// and `pause` fires "occasionally" per the work order.
const DEFAULT_WEIGHTS = [0.2, 0.2, 0.15, 0.15, 0.2, 0.1];

// planExploreSequence — pure, deterministic, no I/O. Exported separately so
// reproducibility can be (and is, in the harness's own proof run) verified
// without touching a browser at all.
function planExploreSequence({ seed, steps, intervalMin, intervalMax, actions = CANONICAL_ACTIONS, weights = DEFAULT_WEIGHTS }) {
  const rng = createRng(seed);
  const held = new Set();
  const plan = [];
  for (let i = 0; i < steps; i++) {
    const action = rng.pick(actions, weights);
    const pressed = !held.has(action);
    if (pressed) held.add(action);
    else held.delete(action);
    const intervalMs = rng.int(intervalMin, intervalMax);
    plan.push({ i, action, pressed, intervalMs });
  }
  return plan;
}

async function runExplore({ page, capture, seed, steps, intervalMin, intervalMax }) {
  const plan = planExploreSequence({ seed, steps, intervalMin, intervalMax });

  // Reseed the page's own PRNG too, so gameplay randomness (e.g. serve angle)
  // is anchored to --seed as well, not just the Node-side action choices.
  await page.evaluate((s) => {
    if (window.__test) window.__test.seed(s);
  }, seed);

  await capture.poll(); // state right after the fresh load (+ reseed)

  for (const step of plan) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(
      ([a, p]) => window.__test.input(a, p),
      [step.action, step.pressed],
    );
    // eslint-disable-next-line no-await-in-loop
    await capture.poll();
    // Real wall-clock wait — this is what lets the rAF loop actually run
    // between decisions, which is what makes the FPS series and the 5s
    // periodic screenshot cadence genuinely exercised.
    // eslint-disable-next-line no-await-in-loop
    await capture.pollFor(step.intervalMs);
  }

  // Cleanup: release anything still held so the run ends on a clean edge.
  // Not part of the planned/digested sequence (purely a courtesy release).
  const stillHeld = plan.reduce((set, step) => {
    if (step.pressed) set.add(step.action);
    else set.delete(step.action);
    return set;
  }, new Set());
  for (const action of stillHeld) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(([a]) => window.__test.input(a, false), [action]);
  }
  await capture.poll();

  const fpsSeries = await page.evaluate(() => window.__playtestFps || []);
  const finalSnapshot = await page.evaluate(() => window.__test.snapshot());
  const errors = await page.evaluate(() => window.__test.errors || []);

  return {
    seed,
    steps,
    intervalMin,
    intervalMax,
    actionSequence: plan.map((s) => ({ action: s.action, pressed: s.pressed, intervalMs: s.intervalMs })),
    statesVisited: capture.statesVisited,
    reachedPlaying: capture.statesVisited.includes('PLAYING'),
    durationMs: capture.durationMs(),
    fpsSeries,
    screenshots: { transitions: capture.transitionShots, periodic: capture.periodicShots },
    finalSnapshot,
    errors,
  };
}

module.exports = { runExplore, planExploreSequence, CANONICAL_ACTIONS, DEFAULT_WEIGHTS };
