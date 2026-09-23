#!/usr/bin/env node
/* =============================================================================
 * tools/playtest/index.js — the playtest harness behind
 *   npm run playtest -- <game-dir>
 *
 * Plays a game TWICE against a real local static server (no file://):
 *   1. the game's scripted probe (games/<game>/playtest.probe.js), if present;
 *   2. a bounded, seeded, exploratory "mash the canonical actions" session.
 *
 * For both runs it captures: screenshots on every __test.state() transition
 * PLUS every ~5s of wall-clock progress, an FPS sample series (real rAF
 * timestamps), the final __test.snapshot(), the states visited in order, and
 * __test.errors. It writes <game-dir>/playtest-report/ containing the
 * screenshots, report.json (machine-readable) and report.md (pre-filled,
 * human/agent-completed).
 *
 * Exit code is non-zero if: the harness itself failed; either run recorded
 * any __test.errors; or a (non-skipped) run never reached PLAYING.
 *
 * CLI:
 *   npm run playtest -- <game-dir> [--headed] [--seed=N]
 *       [--explore-steps=N] [--explore-interval-min=MS] [--explore-interval-max=MS]
 *       [--tick-chunk=N] [--periodic-ms=MS] [--poll-ms=MS]
 *
 * <game-dir> may be relative (from cwd) or absolute, with or without a
 * trailing slash, as long as it resolves to a directory containing an
 * index.html (usually a games/<name> dir in this repo, but an out-of-repo
 * dir works too — see the failure-path proof note in resolveGameDir below).
 *
 * Headed mode (see a real browser window): --headed, or env PLAYTEST_HEADED=1.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const { startStaticServer } = require('./lib/staticServer');
const { installFpsSampler, fpsStats } = require('./lib/fpsSampler');
const { CaptureSession } = require('./lib/capture');
const { runProbe } = require('./lib/probeRunner');
const { runExplore } = require('./lib/exploreRunner');
const { sha256OfCanonicalJson } = require('./lib/digest');
const { buildReportMd } = require('./lib/reportMd');

const HARNESS_VERSION = '1.0.0';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  seed: 424242,
  exploreSteps: 120,
  exploreIntervalMin: 250,
  exploreIntervalMax: 550,
  tickChunk: 20,
  periodicMs: 5000,
  pollMs: 100,
};

function usage() {
  return [
    'Usage: npm run playtest -- <game-dir> [options]',
    '',
    'Example: npm run playtest -- games/fixture-pong',
    '',
    'Options:',
    '  --headed                    Run a headed (visible) browser instead of headless.',
    '                              (env PLAYTEST_HEADED=1 does the same.)',
    `  --seed=N                    Seed for the exploratory session (default ${DEFAULTS.seed}).`,
    `  --explore-steps=N           Number of exploratory action decisions (default ${DEFAULTS.exploreSteps}).`,
    `  --explore-interval-min=MS   Min real ms between exploratory decisions (default ${DEFAULTS.exploreIntervalMin}).`,
    `  --explore-interval-max=MS   Max real ms between exploratory decisions (default ${DEFAULTS.exploreIntervalMax}).`,
    `  --tick-chunk=N              Max __test.tick() step size per call while replaying a probe (default ${DEFAULTS.tickChunk}).`,
    `  --periodic-ms=MS            Wall-clock cadence for periodic screenshots (default ${DEFAULTS.periodicMs}).`,
    `  --poll-ms=MS                State-poll interval used to catch transitions during waits (default ${DEFAULTS.pollMs}).`,
    '  --help, -h                  Show this message.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { ...DEFAULTS, headed: process.env.PLAYTEST_HEADED === '1', gameDirArg: null, help: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') { out.help = true; continue; }
    if (raw === '--headed') { out.headed = true; continue; }
    const m = raw.match(/^--([a-z-]+)=(.+)$/);
    if (m) {
      const key = m[1];
      const val = m[2];
      switch (key) {
        case 'seed': out.seed = Number(val); break;
        case 'explore-steps': out.exploreSteps = Number(val); break;
        case 'explore-interval-min': out.exploreIntervalMin = Number(val); break;
        case 'explore-interval-max': out.exploreIntervalMax = Number(val); break;
        case 'tick-chunk': out.tickChunk = Number(val); break;
        case 'periodic-ms': out.periodicMs = Number(val); break;
        case 'poll-ms': out.pollMs = Number(val); break;
        default:
          throw new Error(`Unknown option --${key}`);
      }
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`Unknown option ${raw}`);
    if (out.gameDirArg === null) { out.gameDirArg = raw; continue; }
    throw new Error(`Unexpected extra argument: ${raw}`);
  }
  return out;
}

// Resolve the game-dir argument (relative-to-cwd or absolute, trailing slash
// tolerated) to { absDir, servedRoot, urlPath, name }, or null if invalid.
// The static server is rooted at the game dir's OWN PARENT directory (not
// hardcoded to the repo root) — this is what lets the harness point at any
// self-contained game dir, in this repo (the normal case) or anywhere else
// (e.g. a /tmp copy used to prove the failure path without touching the
// repo's own fixture), while still serving it over plain HTTP, never file://.
function resolveGameDir(arg) {
  if (!arg) return null;
  const stripped = arg.endsWith('/') ? arg.slice(0, -1) : arg;
  const absDir = path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return null;
  if (!fs.existsSync(path.join(absDir, 'index.html'))) return null;
  const name = path.basename(absDir);
  return { absDir, servedRoot: path.dirname(absDir), urlPath: name, name };
}

function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch (_) {
    return null;
  }
}

function prepareReportDir(gameDir) {
  const reportDir = path.join(gameDir, 'playtest-report');
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });
  return reportDir;
}

async function waitForTestHook(page) {
  await page.waitForFunction(() => !!window.__test, null, { timeout: 10000 });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${usage()}\n`);
    process.exit(2);
    return;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
    return;
  }

  const resolved = resolveGameDir(opts.gameDirArg);
  if (!resolved) {
    process.stderr.write(
      `Missing or invalid game dir: ${opts.gameDirArg || '(none given)'}\n` +
      `Expected a directory (relative or absolute, trailing slash OK) containing index.html.\n\n${usage()}\n`,
    );
    process.exit(2);
    return;
  }
  const { absDir: gameDir, servedRoot, urlPath, name: gameName } = resolved;
  const reportDir = prepareReportDir(gameDir);
  // Display path in the report: relative to the repo when the game dir is
  // inside it (the normal case); the absolute path otherwise (e.g. a /tmp
  // copy used only to prove the failure path).
  const displayGameDir = (() => {
    const rel = path.relative(REPO_ROOT, gameDir);
    return rel.startsWith('..') || path.isAbsolute(rel) ? gameDir : rel.split(path.sep).join('/');
  })();

  let server;
  let browser;
  let exitCode = 0;
  let exitReason = null;

  try {
    server = await startStaticServer(servedRoot);
    browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installFpsSampler);

    const url = `${server.baseUrl}/${urlPath}/index.html?test=1`;

    // ---- Run 1: scripted probe --------------------------------------------
    await page.goto(url, { waitUntil: 'load' });
    await waitForTestHook(page);
    const probeCapture = new CaptureSession({
      page, outDir: reportDir, prefix: 'probe', periodicMs: opts.periodicMs, pollMs: opts.pollMs,
    });
    const probeResult = await runProbe({ page, gameDir, capture: probeCapture, tickChunk: opts.tickChunk });

    // ---- Run 2: bounded seeded exploratory session (fresh page load) ------
    await page.goto(url, { waitUntil: 'load' });
    await waitForTestHook(page);
    const exploreCapture = new CaptureSession({
      page, outDir: reportDir, prefix: 'explore', periodicMs: opts.periodicMs, pollMs: opts.pollMs,
    });
    const exploreResult = await runExplore({
      page,
      capture: exploreCapture,
      seed: opts.seed,
      steps: opts.exploreSteps,
      intervalMin: opts.exploreIntervalMin,
      intervalMax: opts.exploreIntervalMax,
    });

    await context.close();
    await browser.close();
    browser = null;
    await server.close();
    server = null;

    // ---- Assemble report.json ----------------------------------------------
    const probeFpsStats = fpsStats(probeResult.fpsSeries);
    const exploreFpsStats = fpsStats(exploreResult.fpsSeries);
    const probeErrorCount = probeResult.skipped ? 0 : probeResult.errors.length;
    const exploreErrorCount = exploreResult.errors.length;
    const overallErrorCount = probeErrorCount + exploreErrorCount;

    const actionSequenceForDigest = exploreResult.actionSequence.map((s) => ({ action: s.action, pressed: s.pressed }));

    const reportData = {
      game: gameName,
      gameDir: displayGameDir,
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      harness: {
        version: HARNESS_VERSION,
        seed: opts.seed,
        exploreSteps: opts.exploreSteps,
        exploreIntervalMs: [opts.exploreIntervalMin, opts.exploreIntervalMax],
        tickChunk: opts.tickChunk,
        periodicScreenshotMs: opts.periodicMs,
        pollMs: opts.pollMs,
        headed: opts.headed,
      },
      runs: {
        probe: {
          skipped: probeResult.skipped,
          reason: probeResult.reason,
          probeName: probeResult.name,
          stepCount: probeResult.stepCount,
          statesVisited: probeResult.statesVisited,
          reachedPlaying: probeResult.reachedPlaying,
          durationMs: probeResult.durationMs,
          fps: { ...probeFpsStats, series: probeResult.fpsSeries },
          screenshots: probeResult.screenshots,
          finalSnapshot: probeResult.finalSnapshot,
          snapshotDigest: probeResult.finalSnapshot ? sha256OfCanonicalJson(probeResult.finalSnapshot) : null,
          errors: probeResult.errors,
        },
        explore: {
          seed: exploreResult.seed,
          steps: exploreResult.steps,
          intervalMin: exploreResult.intervalMin,
          intervalMax: exploreResult.intervalMax,
          statesVisited: exploreResult.statesVisited,
          reachedPlaying: exploreResult.reachedPlaying,
          durationMs: exploreResult.durationMs,
          fps: { ...exploreFpsStats, series: exploreResult.fpsSeries },
          screenshots: exploreResult.screenshots,
          finalSnapshot: exploreResult.finalSnapshot,
          snapshotDigest: exploreResult.finalSnapshot ? sha256OfCanonicalJson(exploreResult.finalSnapshot) : null,
          errors: exploreResult.errors,
          actionSequence: exploreResult.actionSequence,
          actionSequenceDigest: sha256OfCanonicalJson(actionSequenceForDigest),
        },
      },
      overallErrorCount,
    };

    // ---- Exit code determination --------------------------------------------
    const reasons = [];
    if (overallErrorCount > 0) reasons.push('game produced __test.errors entries');
    if (!probeResult.skipped && !probeResult.reachedPlaying) reasons.push('probe run never reached PLAYING');
    if (!exploreResult.reachedPlaying) reasons.push('exploratory run never reached PLAYING');
    if (reasons.length > 0) {
      exitCode = 1;
      exitReason = reasons.join('; ');
    }
    reportData.exitReason = exitReason;

    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(reportData, null, 2));
    fs.writeFileSync(path.join(reportDir, 'report.md'), buildReportMd(reportData));

    if (exitCode === 0) {
      process.stdout.write(
        `playtest OK: ${gameName}\n` +
        `  probe: ${probeResult.skipped ? 'skipped (no probe file)' : `"${probeResult.name}" — states ${probeResult.statesVisited.join(' -> ')}`}\n` +
        `  exploratory: seed=${opts.seed} steps=${opts.exploreSteps} — states ${exploreResult.statesVisited.join(' -> ')}\n` +
        `  errors: ${overallErrorCount}\n` +
        `  report: ${path.relative(process.cwd(), reportDir)}${path.sep}report.json / report.md\n`,
      );
    } else {
      process.stderr.write(
        `playtest FAILED: ${gameName}\n` +
        `  reason: ${exitReason}\n` +
        `  errors: ${JSON.stringify([...(probeResult.errors || []), ...(exploreResult.errors || [])])}\n` +
        `  report: ${path.relative(process.cwd(), reportDir)}${path.sep}report.json / report.md\n`,
      );
    }
    process.exit(exitCode);
  } catch (err) {
    process.stderr.write(`playtest harness error: ${err && err.stack ? err.stack : err}\n`);
    try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
    try { if (server) await server.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
}

main();
