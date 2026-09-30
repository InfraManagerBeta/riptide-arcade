'use strict';
/* =============================================================================
 * tools/verify/determinism.js — same seed + same scripted inputs, run twice,
 * from two FRESH page loads ⇒ identical final snapshots.
 *
 * CRITICAL (learned the hard way in t1): the live rAF loop keeps advancing
 * real time between separate page.evaluate calls. The whole seed -> inputs ->
 * ticks sequence for EACH run happens inside ONE page.evaluate, so nothing
 * about Node's own scheduling can leak into the result.
 *
 * Runs hundreds of ticks (a script long enough to touch a paddle-hit, a miss,
 * a serve reseed, and typically GAME_OVER) so a hidden Math.random or a stray
 * Date.now()/performance.now() read has room to show up as drift. Also
 * asserts __test.errors contains no `math.random` entries in either run —
 * the template redirects Math.random through rng() under test mode and
 * records a defect when a game calls it, which is the more direct signal a
 * lying "looks deterministic" game would trip.
 *
 * Standalone: `node tools/verify/determinism.js <game-dir>`.
 * ========================================================================== */

const lib = require('./lib');

const SEED = 1337;

// The exact same scripted drive for both runs — passed as a function into
// page.evaluate() each time so the source is byte-identical across runs.
function scriptedDrive(seed) {
  const t = window.__test;
  t.seed(seed);

  // Serve.
  t.input('primary', true);
  t.tick(2);
  t.input('primary', false);
  t.tick(1);

  // A deterministic wiggle pattern — enough ticks to touch paddle-hit,
  // miss/serve-reseed and (likely) GAME_OVER, which is exactly where a
  // hidden Math.random or wall-clock read would first show up as drift.
  for (let i = 0; i < 6; i++) {
    t.input('left', true);
    t.tick(10);
    t.input('left', false);
    t.input('right', true);
    t.tick(10);
    t.input('right', false);
    t.tick(5);
  }
  t.tick(200);

  return { state: t.state(), snapshot: t.snapshot(), errors: t.errors.slice() };
}

async function runOnce(ctx) {
  const page = await ctx.openPage();
  try {
    return await page.evaluate(scriptedDrive, SEED);
  } finally {
    await page.close().catch(() => {});
  }
}

async function run(ctx) {
  const totalTicksPerRun = 2 + 1 + 6 * (10 + 10 + 5) + 200; // = 353, "hundreds" per the order
  const run1 = await runOnce(ctx); // fresh page load #1
  const run2 = await runOnce(ctx); // fresh page load #2

  const mathRandomHits = [
    ...run1.errors.filter((e) => e.type === 'math.random').map((e) => ({ run: 1, ...e })),
    ...run2.errors.filter((e) => e.type === 'math.random').map((e) => ({ run: 2, ...e })),
  ];
  if (mathRandomHits.length > 0) {
    throw new Error(
      `determinism: Math.random() was called under test mode (${totalTicksPerRun} ticks/run) — ` +
      `the template traps this as a defect because it breaks determinism:\n` +
      mathRandomHits.map((e) => `  run${e.run}: ${e.message}`).join('\n'));
  }

  if (run1.state !== run2.state) {
    throw new Error(
      `determinism: final state differs across two identical runs (seed=${SEED}, ` +
      `${totalTicksPerRun} ticks): run1=${run1.state} run2=${run2.state}`);
  }

  const diffs = lib.diffFlat(run1.snapshot, run2.snapshot);
  if (diffs.length > 0) {
    throw new Error(
      `determinism: final snapshots differ across two identical runs (seed=${SEED}, ` +
      `${totalTicksPerRun} ticks) on ${diffs.length} field(s):\n` +
      diffs.map((d) => `  ${d.path}: run1=${JSON.stringify(d.a)} run2=${JSON.stringify(d.b)}`).join('\n') +
      `\nfull run1 snapshot: ${JSON.stringify(run1.snapshot)}` +
      `\nfull run2 snapshot: ${JSON.stringify(run2.snapshot)}`);
  }

  const anyErrors = [...run1.errors, ...run2.errors];
  if (anyErrors.length > 0) {
    throw new Error(
      `determinism: __test.errors not empty across the two runs (state matched, but this is still a ` +
      `defect the drive surfaced):\n` +
      anyErrors.map((e) => `  [${e.type}] ${e.message}`).join('\n'));
  }
}

module.exports = { name: 'determinism', run };

if (require.main === module) lib.cliMain(module.exports);
