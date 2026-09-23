// Executes games/<game>/playtest.probe.js against a loaded page, per the
// pinned PROBE CONTRACT:
//   module.exports = { name: string, steps: Array<{ action?, pressed?, ticks?, waitMs? }> }
// Applied in order, per step: if `action` present -> __test.input(action,
// pressed !== false); if `ticks` present -> __test.tick(ticks); if `waitMs`
// present -> wait that many REAL milliseconds.
'use strict';

const fs = require('fs');
const path = require('path');

// __test.tick(n) is chunked into small groups so the capture session's
// transition-polling actually gets a chance to observe intermediate states
// inside a single big `ticks` step, instead of only seeing the state after
// the whole step completes.
const DEFAULT_TICK_CHUNK = 20;

function loadProbe(gameDir) {
  const probePath = path.join(gameDir, 'playtest.probe.js');
  if (!fs.existsSync(probePath)) return null;
  // fresh require every invocation (harness may run in one long-lived process)
  delete require.cache[require.resolve(probePath)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const probe = require(probePath);
  if (!probe || typeof probe !== 'object' || !Array.isArray(probe.steps)) {
    throw new Error(`playtest.probe.js at ${probePath} did not export { name, steps: [] }`);
  }
  return probe;
}

async function runProbe({ page, gameDir, capture, tickChunk = DEFAULT_TICK_CHUNK }) {
  const probe = loadProbe(gameDir);
  if (!probe) {
    return {
      skipped: true,
      reason: 'no playtest.probe.js found in game dir — probe run skipped',
      name: null,
      stepCount: 0,
      statesVisited: [],
      reachedPlaying: false,
      durationMs: 0,
      fpsSeries: [],
      screenshots: { transitions: [], periodic: [] },
      finalSnapshot: null,
      errors: [],
    };
  }

  await capture.poll(); // capture the state we land on right after navigation

  for (const step of probe.steps) {
    if (step.action !== undefined) {
      const pressed = step.pressed !== false;
      await page.evaluate(
        ([a, p]) => window.__test.input(a, p),
        [step.action, pressed],
      );
      await capture.poll();
    }
    if (step.ticks !== undefined) {
      let remaining = Math.max(0, Math.floor(step.ticks));
      while (remaining > 0) {
        const chunk = Math.min(tickChunk, remaining);
        // eslint-disable-next-line no-await-in-loop
        await page.evaluate((n) => window.__test.tick(n), chunk);
        remaining -= chunk;
        // eslint-disable-next-line no-await-in-loop
        await capture.poll();
      }
    }
    if (step.waitMs !== undefined) {
      await capture.pollFor(step.waitMs);
    }
  }

  const fpsSeries = await page.evaluate(() => window.__playtestFps || []);
  const finalSnapshot = await page.evaluate(() => window.__test.snapshot());
  const errors = await page.evaluate(() => window.__test.errors || []);

  return {
    skipped: false,
    reason: null,
    name: probe.name,
    stepCount: probe.steps.length,
    statesVisited: capture.statesVisited,
    reachedPlaying: capture.statesVisited.includes('PLAYING'),
    durationMs: capture.durationMs(),
    fpsSeries,
    screenshots: { transitions: capture.transitionShots, periodic: capture.periodicShots },
    finalSnapshot,
    errors,
  };
}

module.exports = { runProbe, loadProbe, DEFAULT_TICK_CHUNK };
