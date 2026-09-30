'use strict';
/* =============================================================================
 * tools/verify/smoke.js — the fast, coarse "does it even boot" check.
 *
 * CONTRACT (spec section 2 + the __test contract in the order):
 *   1. load with ?test=1
 *   2. wait for MENU
 *   3. assert __test.errors is empty
 *   4. start the game via injected input (primary)
 *   5. tick(600)
 *   6. assert the state is sane (a known state, not stuck in LOADING)
 *   7. assert __test.errors is still empty
 *
 * Standalone: `node tools/verify/smoke.js <game-dir>`.
 * ========================================================================== */

const lib = require('./lib');

const KNOWN_STATES = ['LOADING', 'MENU', 'PLAYING', 'PAUSED', 'GAME_OVER'];
const MENU_WAIT_MS = 5000;

async function run(ctx) {
  const page = await ctx.openPage();
  try {
    // Step 2: wait specifically for MENU (openPage only guarantees "left
    // LOADING" — a game that skips straight past MENU would slip through a
    // weaker check).
    try {
      await page.waitForFunction(() => window.__test.state() === 'MENU', null, { timeout: MENU_WAIT_MS });
    } catch (_) {
      const state = await page.evaluate(() => window.__test.state());
      const snapshot = await page.evaluate(() => window.__test.snapshot());
      throw new Error(
        `expected state MENU within ${MENU_WAIT_MS}ms of load, observed state=${state}\n` +
        `snapshot at failure: ${JSON.stringify(snapshot)}`);
    }

    // Step 3: errors must be empty at MENU.
    let errors = await page.evaluate(() => window.__test.errors.slice());
    if (errors.length > 0) {
      throw new Error(
        `expected __test.errors empty at MENU, observed ${errors.length} error(s):\n` +
        errors.map((e) => `  [${e.type}] ${e.message}`).join('\n'));
    }

    // Step 4: start the game via injected input (menu -> playing), through
    // the same setAction chokepoint every real input goes through.
    await page.evaluate(() => {
      const t = window.__test;
      t.input('primary', true);
      t.tick(2);
      t.input('primary', false);
      t.tick(1);
    });
    const afterStart = await page.evaluate(() => window.__test.state());
    if (afterStart !== 'PLAYING') {
      const snapshot = await page.evaluate(() => window.__test.snapshot());
      throw new Error(
        `expected state PLAYING after injecting primary from MENU, observed state=${afterStart}\n` +
        `snapshot at failure: ${JSON.stringify(snapshot)}`);
    }

    // Step 5: tick(600) — well past fixture-pong's ~117-tick unattended
    // GAME_OVER, proving the loop survives well beyond a single life cycle.
    await page.evaluate(() => window.__test.tick(600));

    // Step 6: state must be sane — one of the known states, never stuck in
    // LOADING (a game that never leaves LOADING after ticking is broken).
    const finalState = await page.evaluate(() => window.__test.state());
    const finalSnapshot = await page.evaluate(() => window.__test.snapshot());
    if (!KNOWN_STATES.includes(finalState) || finalState === 'LOADING') {
      throw new Error(
        `expected a known, non-LOADING state after tick(600), observed state=${JSON.stringify(finalState)}\n` +
        `snapshot at failure: ${JSON.stringify(finalSnapshot)}`);
    }

    // Step 7: errors must STILL be empty after 600 ticks of simulation.
    errors = await page.evaluate(() => window.__test.errors.slice());
    if (errors.length > 0) {
      throw new Error(
        `expected __test.errors empty after tick(600), observed ${errors.length} error(s):\n` +
        errors.map((e) => `  [${e.type}] ${e.message}`).join('\n') + '\n' +
        `state at failure: ${finalState}\n` +
        `snapshot at failure: ${JSON.stringify(finalSnapshot)}`);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { name: 'smoke', run };

if (require.main === module) lib.cliMain(module.exports);
