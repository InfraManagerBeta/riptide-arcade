'use strict';
/* =============================================================================
 * tools/verify/journey.js — walks the full state graph via injected inputs
 * and proves gameplay actually advances, not just the state label.
 *
 * menu -> playing -> paused -> playing -> game over -> restart
 *
 * After EACH transition this asserts:
 *   (a) the state changed to the expected value, and
 *   (b) the snapshot changed in a way that proves the transition was real
 *       (not a state flip over frozen data).
 * For the PLAYING interior specifically (the target bug class: a transition
 * that updates state fields but freezes gameplay) it also runs a batch of
 * ticks and requires genuine numeric movement — and, symmetrically, requires
 * that NOTHING moves while PAUSED.
 *
 * "Genuine movement" heuristic: at least one changed numeric leaf field whose
 * path is not itself a tick/frame counter (e.g. `ticks`, `totalTicks`). A
 * counter alone can keep incrementing even when the actual simulation (ball,
 * paddle, score, timers) is frozen — that half-frozen shape is exactly the
 * bug this verifier hunts, so a counter-only change does not count as proof.
 *
 * PLAYING -> GAME_OVER: not every game can lose while idle (unlike
 * fixture-pong). A game dir MAY ship an OPTIONAL `verify.hints.js`
 * (CommonJS): `module.exports = { toGameOver: Step[], restart?: Step[] }`,
 * where `Step` is the SAME shape tools/playtest already uses —
 * `{ action?, pressed?, ticks?, waitMs? }` — applied in order per step:
 * inject action -> tick -> wait. When `toGameOver` is declared, those steps
 * drive the PLAYING -> GAME_OVER transition instead of the bounded idle
 * search; when `restart` is declared, those steps drive GAME_OVER -> PLAYING
 * instead of the default single primary press. Without the file (or without
 * a given key), the previous bounded-idle-tick / single-primary-press
 * behaviour is unchanged. See README.md ("Building a game") and
 * docs/spec-template.md (§5 Verification) for the author-facing summary.
 *
 * The whole drive runs inside ONE page.evaluate from a fresh load (per the
 * CRITICAL rule: the live rAF loop keeps advancing real time between
 * separate evaluates), so this verifier's own pass/fail can never be flaky
 * because of an incidental extra frame between Node round-trips. Hint steps
 * are driven from INSIDE that same evaluate (a `waitMs` step awaits a
 * page-local `setTimeout`, never a second Node round-trip).
 *
 * Standalone: `node tools/verify/journey.js <game-dir>`.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ADVANCE_TICKS = 30; // enough ticks for real motion at any sane game speed
const GAME_OVER_GUARD = 2000; // bounded search for GAME_OVER with no input (fallback only)
const HINTS_FILENAME = 'verify.hints.js';

const TICK_FIELD_RE = /(^|\.)(ticks?|totalTicks)$/i;

function changedNumericFields(before, after) {
  return lib.diffFlat(before, after).filter((d) => typeof d.a === 'number' || typeof d.b === 'number');
}

function nonCounterChanges(changed) {
  return changed.filter((d) => !TICK_FIELD_RE.test(d.path));
}

function fmtDiff(diffs) {
  return diffs.map((d) => `  ${d.path}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Optional games/<game>/verify.hints.js — see the file header for the
// contract. `Step` is intentionally the exact shape tools/playtest/lib's
// probeRunner already uses: { action?, pressed?, ticks?, waitMs? }. Kept
// self-contained in journey.js (not lib.js) since ticket t3's boundary is
// tools/verify/ and this hint file only matters to this verifier.
// ---------------------------------------------------------------------------
function isStepArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((s) => s && typeof s === 'object');
}

function loadHints(gameDir) {
  const hintsPath = path.join(gameDir, HINTS_FILENAME);
  if (!fs.existsSync(hintsPath)) {
    return { hintsPath, present: false, toGameOver: null, restart: null };
  }
  // Fresh require every invocation (index.js runs verifiers in one process).
  delete require.cache[require.resolve(hintsPath)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const hints = require(hintsPath);
  if (!hints || typeof hints !== 'object') {
    throw new Error(
      `${HINTS_FILENAME} at ${hintsPath} did not export an object ` +
      '(expected { toGameOver: [ { action, pressed, ticks } ], restart? })');
  }
  return {
    hintsPath,
    present: true,
    toGameOver: isStepArray(hints.toGameOver) ? hints.toGameOver : null,
    restart: isStepArray(hints.restart) ? hints.restart : null,
  };
}

async function run(ctx) {
  const page = await ctx.openPage();
  try {
    const hints = loadHints(ctx.gameDir);

    const trace = await page.evaluate(async ({ advanceTicks, guard, toGameOverSteps, restartSteps }) => {
      const t = window.__test;
      const snap = () => t.snapshot();

      // Drives the SAME step shape tools/playtest uses, in order, per step:
      // inject action -> tick -> wait (real page-local ms, no Node round-trip).
      async function driveSteps(steps) {
        for (const step of steps || []) {
          if (step && step.action !== undefined) {
            t.input(step.action, step.pressed !== false);
          }
          if (step && step.ticks !== undefined) {
            t.tick(step.ticks);
          }
          if (step && step.waitMs !== undefined) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, step.waitMs));
          }
        }
      }

      const out = {};
      out.initial = { state: t.state(), snapshot: snap() };

      // ---- Transition 1: MENU -> PLAYING (serve) ----------------------------
      const beforeServe = snap();
      t.input('primary', true);
      t.tick(1); // the tick that consumes the rising edge
      const rightAfterServe = { state: t.state(), snapshot: snap() };
      t.input('primary', false);
      t.tick(1);
      out.serve = { before: beforeServe, immediatelyAfter: rightAfterServe, settled: { state: t.state(), snapshot: snap() } };

      // Prove PLAYING genuinely advances (the target bug class: frozen sim).
      const beforePlay = snap();
      t.tick(advanceTicks);
      const afterPlay = snap();
      out.playingAdvance = { before: beforePlay, after: afterPlay };

      // ---- Transition 2: PLAYING -> PAUSED -----------------------------------
      const beforePause = snap();
      t.input('pause', true);
      t.tick(1);
      const rightAfterPause = { state: t.state(), snapshot: snap() };
      t.input('pause', false);
      t.tick(1);
      out.pause = { before: beforePause, immediatelyAfter: rightAfterPause, settled: { state: t.state(), snapshot: snap() } };

      // Prove PAUSED genuinely freezes (equally required, symmetric check).
      const beforeHold = snap();
      t.tick(advanceTicks);
      const afterHold = snap();
      out.pausedHold = { before: beforeHold, after: afterHold };

      // ---- Transition 3: PAUSED -> PLAYING (resume) --------------------------
      const beforeResume = snap();
      t.input('pause', true);
      t.tick(1);
      const rightAfterResume = { state: t.state(), snapshot: snap() };
      t.input('pause', false);
      t.tick(1);
      out.resume = { before: beforeResume, immediatelyAfter: rightAfterResume, settled: { state: t.state(), snapshot: snap() } };

      // Prove play resumes advancing after the pause interlude.
      const beforeResumePlay = snap();
      t.tick(advanceTicks);
      const afterResumePlay = snap();
      out.resumeAdvance = { before: beforeResumePlay, after: afterResumePlay };

      // ---- Transition 4: PLAYING -> GAME_OVER --------------------------------
      // Hinted path (verify.hints.js declares toGameOver): drive those steps.
      // Fallback (no hints, or no toGameOver key): bounded idle-tick search,
      // unchanged from before — this is what already works for games (like
      // fixture-pong) whose serve angles guarantee GAME_OVER unattended.
      const beforeGameOver = snap();
      let ticksUsed = 0;
      let usedHint = false;
      if (toGameOverSteps) {
        usedHint = true;
        await driveSteps(toGameOverSteps);
      } else {
        while (t.state() !== 'GAME_OVER' && ticksUsed < guard) { t.tick(1); ticksUsed++; }
      }
      out.gameOver = {
        before: beforeGameOver,
        after: { state: t.state(), snapshot: snap() },
        ticksUsed,
        usedHint,
        guardExhausted: !usedHint && ticksUsed >= guard,
      };

      // ---- Transition 5: GAME_OVER -> PLAYING (restart) ----------------------
      // Hinted path (verify.hints.js declares restart): drive those steps.
      // Fallback: the original single primary press/release.
      const beforeRestart = snap();
      let usedRestartHint = false;
      if (restartSteps) {
        usedRestartHint = true;
        await driveSteps(restartSteps);
      } else {
        t.input('primary', true);
        t.tick(1);
        t.input('primary', false);
        t.tick(1);
      }
      out.restart = { before: beforeRestart, settled: { state: t.state(), snapshot: snap() }, usedHint: usedRestartHint };

      // Prove the restarted run is actually simulating too.
      const beforeRestartPlay = snap();
      t.tick(advanceTicks);
      const afterRestartPlay = snap();
      out.restartAdvance = { before: beforeRestartPlay, after: afterRestartPlay };

      out.errors = t.errors.slice();
      return out;
    }, {
      advanceTicks: ADVANCE_TICKS,
      guard: GAME_OVER_GUARD,
      toGameOverSteps: hints.toGameOver,
      restartSteps: hints.restart,
    });

    // ---- Assertions (Node side; the drive above already returned) -----------
    const fail = (label, detail) => {
      throw new Error(`${label}\n${detail}`);
    };

    // Transition 1: MENU -> PLAYING
    if (trace.serve.settled.state !== 'PLAYING') {
      fail('journey: MENU -> PLAYING did not happen',
        `expected state PLAYING after injecting primary from MENU, observed ` +
        `${trace.serve.settled.state}\nsnapshot: ${JSON.stringify(trace.serve.settled.snapshot)}\n` +
        `(this is the exact shape of a MENU handler that never calls setState)`);
    }
    {
      const diffs = lib.diffFlat(trace.serve.before, trace.serve.settled.snapshot);
      if (diffs.length === 0) {
        fail('journey: MENU -> PLAYING transition left the snapshot completely unchanged',
          'expected at least the `state` field (and typically gameplay fields) to differ');
      }
    }

    // PLAYING must genuinely advance — the target bug class.
    {
      const changed = changedNumericFields(trace.playingAdvance.before, trace.playingAdvance.after);
      const real = nonCounterChanges(changed);
      if (real.length === 0) {
        fail(
          `journey: PLAYING did not advance over ${ADVANCE_TICKS} ticks (frozen-simulation bug class)`,
          changed.length === 0
            ? 'no numeric snapshot field changed at all'
            : `only counter-like field(s) changed (not proof of real gameplay motion):\n${fmtDiff(changed)}`);
      }
      console.log(`  journey: PLAYING advanced — moved field(s):\n${fmtDiff(real)}`);
    }

    // Transition 2: PLAYING -> PAUSED
    if (trace.pause.settled.state !== 'PAUSED') {
      fail('journey: PLAYING -> PAUSED did not happen',
        `expected state PAUSED after injecting pause from PLAYING, observed ` +
        `${trace.pause.settled.state}\nsnapshot: ${JSON.stringify(trace.pause.settled.snapshot)}`);
    }

    // PAUSED must freeze EVERYTHING — symmetric, stricter than "no numeric
    // movement": nothing in the snapshot may change at all.
    {
      const diffs = lib.diffFlat(trace.pausedHold.before, trace.pausedHold.after);
      if (diffs.length > 0) {
        fail(`journey: snapshot advanced while PAUSED over ${ADVANCE_TICKS} ticks (must freeze)`,
          fmtDiff(diffs));
      }
      console.log('  journey: PAUSED correctly froze the snapshot (no field moved)');
    }

    // Transition 3: PAUSED -> PLAYING
    if (trace.resume.settled.state !== 'PLAYING') {
      fail('journey: PAUSED -> PLAYING did not happen',
        `expected state PLAYING after injecting pause from PAUSED, observed ` +
        `${trace.resume.settled.state}\nsnapshot: ${JSON.stringify(trace.resume.settled.snapshot)}`);
    }
    {
      const changed = changedNumericFields(trace.resumeAdvance.before, trace.resumeAdvance.after);
      const real = nonCounterChanges(changed);
      if (real.length === 0) {
        fail(`journey: PLAYING did not resume advancing after unpause over ${ADVANCE_TICKS} ticks`,
          changed.length === 0
            ? 'no numeric snapshot field changed at all'
            : `only counter-like field(s) changed:\n${fmtDiff(changed)}`);
      }
      console.log(`  journey: resumed PLAYING advanced — moved field(s):\n${fmtDiff(real)}`);
    }

    // Transition 4: PLAYING -> GAME_OVER
    if (trace.gameOver.after.state !== 'GAME_OVER') {
      const stuckDetail = trace.gameOver.usedHint
        ? `state stuck at ${trace.gameOver.after.state} after driving the toGameOver steps from ` +
          `${hints.hintsPath}`
        : `state stuck at ${trace.gameOver.after.state} after ${trace.gameOver.ticksUsed} idle ticks ` +
          `(guard=${GAME_OVER_GUARD})`;
      const actionable = trace.gameOver.usedHint
        ? `Check the toGameOver steps in ${hints.hintsPath} — they did not drive this game to GAME_OVER. ` +
          'Step shape: { action?, pressed?, ticks?, waitMs? } (same as tools/playtest), applied in order ' +
          'per step as inject action -> tick -> wait.'
        : `If this game cannot lose unattended, add games/<game>/verify.hints.js exporting ` +
          '{ toGameOver: [ { action, pressed, ticks } ] } — Step shape: { action?, pressed?, ticks?, ' +
          'waitMs? } (same as tools/playtest), applied in order per step as inject action -> tick -> wait.';
      fail('journey: PLAYING -> GAME_OVER never happened',
        `${stuckDetail}\n${actionable}\nsnapshot: ${JSON.stringify(trace.gameOver.after.snapshot)}`);
    }
    {
      const diffs = lib.diffFlat(trace.gameOver.before, trace.gameOver.after.snapshot);
      if (diffs.length === 0) {
        fail('journey: PLAYING -> GAME_OVER left the snapshot completely unchanged',
          'expected at least `state` (and typically entity/life fields) to differ');
      }
      const via = trace.gameOver.usedHint
        ? `verify.hints.js (${hints.hintsPath})`
        : `${trace.gameOver.ticksUsed} idle ticks`;
      console.log(`  journey: GAME_OVER reached via ${via} — changed field(s):\n${fmtDiff(diffs)}`);
    }

    // Transition 5: GAME_OVER -> PLAYING (restart)
    if (trace.restart.settled.state !== 'PLAYING') {
      const via = trace.restart.usedHint ? ` (drove restart steps from ${hints.hintsPath})` : '';
      fail('journey: GAME_OVER -> PLAYING (restart) did not happen',
        `expected state PLAYING after driving the restart transition${via}, observed ` +
        `${trace.restart.settled.state}\nsnapshot: ${JSON.stringify(trace.restart.settled.snapshot)}`);
    }
    {
      const diffs = lib.diffFlat(trace.restart.before, trace.restart.settled.snapshot);
      if (diffs.length === 0) {
        fail('journey: restart left the snapshot completely unchanged', 'expected at least `state` to differ');
      }
      const changed = changedNumericFields(trace.restartAdvance.before, trace.restartAdvance.after);
      const real = nonCounterChanges(changed);
      if (real.length === 0) {
        fail(`journey: restarted run did not advance over ${ADVANCE_TICKS} ticks`,
          changed.length === 0
            ? 'no numeric snapshot field changed at all'
            : `only counter-like field(s) changed:\n${fmtDiff(changed)}`);
      }
      console.log(`  journey: restarted run advanced — moved field(s):\n${fmtDiff(real)}`);
    }

    if (trace.errors.length > 0) {
      fail('journey: __test.errors is not empty after the full state-graph walk',
        trace.errors.map((e) => `  [${e.type}] ${e.message}`).join('\n'));
    }
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { name: 'journey', run };

if (require.main === module) lib.cliMain(module.exports);
