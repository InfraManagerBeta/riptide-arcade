#!/usr/bin/env node
'use strict';
/* =============================================================================
 * tests/regression/run.js — the permanent regression suite runner.
 * Wired to `npm run regression`.
 *
 * WHAT IT DOES
 *   - Discovers every `tests/regression/*.test.js` (sorted by filename) and
 *     runs them ALL: one test's failure never stops the others.
 *   - Also runs `node tools/verify/budget.selftest.js` as its own suite row
 *     when that file exists (it is built by a parallel ticket); when absent
 *     the row is reported SKIPPED with a reason instead of failing.
 *   - Prints a per-test PASS/FAIL summary table with durations and exits
 *     non-zero if ANY test failed.
 *
 * CLI
 *   npm run regression                                run everything
 *   node tests/regression/run.js <filter> [...]       run a subset: a test runs
 *       if ANY filter is a substring of its name, its game, or its filename
 *       (e.g. `node tests/regression/run.js fixture-pong`)
 *   node tests/regression/run.js --games-root <dir>   serve `/games/<name>/...`
 *       from <dir>/<name>/... instead of the repo's games/ — test plumbing so
 *       a test can be pointed at a deliberately broken copy of a game (used to
 *       prove a regression test actually catches its bug class). Everything
 *       else is still served from the repo root.
 *
 * TEST MODULE CONTRACT (pinned — see README.md)
 *   Each `*.test.js` is CommonJS exporting:
 *     { name: string, game: string, run: async (ctx) => void }
 *   ctx provides { page, openGame, assert }:
 *     - page:     a fresh Playwright Page (one isolated browser context per test)
 *     - openGame: async (gameName, { query } = {}) — navigates the page to
 *                 games/<gameName>/index.html?test=1 (plus extra query params),
 *                 waits until window.__test exists and state() has left
 *                 'LOADING', then resolves with the page.
 *     - assert:   Node's built-in `assert/strict`
 *   A test fails by throwing. The runner reports the message plus, best-effort,
 *   the game state and snapshot at the moment of failure.
 *
 * PLUMBING OWNED HERE (no test framework, Node 20+, playwright only):
 *   - one static HTTP server on 127.0.0.1 (ephemeral port) serving the repo
 *     root — games run over http://, never file://
 *   - one shared Playwright chromium instance for the whole suite
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const assert = require('assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TESTS_DIR = __dirname;
const BUDGET_SELFTEST_REL = path.join('tools', 'verify', 'budget.selftest.js');
const BUDGET_SELFTEST = path.join(REPO_ROOT, BUDGET_SELFTEST_REL);
const OPEN_GAME_TIMEOUT_MS = 15000; // bounded wait for __test + state past LOADING
const TEST_TIMEOUT_MS = 60000;      // a hung test is a FAILED test, not a hung suite

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { filters: [], gamesRoot: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games-root') {
      const v = argv[++i];
      if (!v) { console.error('--games-root requires a directory argument'); process.exit(2); }
      args.gamesRoot = path.resolve(v);
    } else if (a.startsWith('--games-root=')) {
      args.gamesRoot = path.resolve(a.slice('--games-root='.length));
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('-')) {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    } else {
      args.filters.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(
    'usage: node tests/regression/run.js [--games-root <dir>] [filter ...]\n' +
    '  no args        run every tests/regression/*.test.js (plus the budget self-test row)\n' +
    '  filter ...     run only tests whose name, game or filename contains a filter\n' +
    '  --games-root   serve /games/<name>/ from <dir>/<name>/ (test plumbing)');
}

// ---------------------------------------------------------------------------
// Static HTTP server — serves the repo root on 127.0.0.1 (never file://).
// With --games-root, request paths under /games/ resolve into that directory.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function startServer(gamesRoot) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (_) {
      res.writeHead(400).end('bad request');
      return;
    }
    // Normalize and forbid traversal.
    const normalized = path.posix.normalize(pathname);
    if (normalized.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let filePath;
    if (gamesRoot && (normalized === '/games' || normalized.startsWith('/games/'))) {
      filePath = path.join(gamesRoot, normalized.slice('/games/'.length));
    } else {
      filePath = path.join(REPO_ROOT, normalized);
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// openGame helper — the one way tests load a game.
// ---------------------------------------------------------------------------
function makeOpenGame(page, baseURL) {
  return async function openGame(gameName, opts = {}) {
    const params = new URLSearchParams({ test: '1' });
    for (const [k, v] of Object.entries(opts.query || {})) params.set(k, String(v));
    const url = `${baseURL}/games/${gameName}/index.html?${params.toString()}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OPEN_GAME_TIMEOUT_MS });
    await page.waitForFunction(
      () => window.__test &&
            typeof window.__test.state === 'function' &&
            window.__test.state() !== 'LOADING',
      null,
      { timeout: OPEN_GAME_TIMEOUT_MS },
    ).catch((err) => {
      throw new Error(
        `openGame(${JSON.stringify(gameName)}): window.__test did not appear ` +
        `or state never left LOADING within ${OPEN_GAME_TIMEOUT_MS}ms (${err.message})`);
    });
    return page;
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function printTable(rows) {
  const cols = [
    { h: 'RESULT', get: (r) => r.status },
    { h: 'TEST', get: (r) => r.name },
    { h: 'GAME', get: (r) => r.game || '-' },
    { h: 'DURATION', get: (r) => `${r.ms}ms` },
    { h: 'DETAIL', get: (r) => r.detail || '' },
  ];
  const widths = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => '  ' + cells.map((s, i) => String(s).padEnd(widths[i])).join('  ').trimEnd();
  const sep = '  ' + widths.map((w) => '-'.repeat(w)).join('  ');
  console.log('');
  console.log(line(cols.map((c) => c.h)));
  console.log(sep);
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (args.gamesRoot && !fs.existsSync(args.gamesRoot)) {
    console.error(`--games-root: no such directory: ${args.gamesRoot}`);
    return 2;
  }

  // Discover test modules.
  const files = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js')).sort();
  const modules = [];
  for (const file of files) {
    try {
      const mod = require(path.join(TESTS_DIR, file));
      modules.push({ file, mod });
    } catch (err) {
      // A module that cannot even be loaded is a FAILED test, not a crash.
      modules.push({ file, mod: null, loadError: err });
    }
  }

  const matches = (m) => {
    if (args.filters.length === 0) return true;
    const name = (m.mod && m.mod.name) || m.file;
    const game = (m.mod && m.mod.game) || '';
    return args.filters.some((f) => name.includes(f) || game.includes(f) || m.file.includes(f));
  };
  const selected = modules.filter(matches);

  // The budget self-test row participates in filtering under its own name.
  const selftestSelected =
    args.filters.length === 0 ||
    args.filters.some((f) => 'budget.selftest'.includes(f) || BUDGET_SELFTEST_REL.includes(f));

  if (selected.length === 0 && !selftestSelected) {
    console.error(`no tests matched filter(s): ${args.filters.join(', ')}`);
    return 1;
  }

  const rows = [];
  let browser = null;
  let served = null;

  if (selected.length > 0) {
    served = await startServer(args.gamesRoot);
    console.log(`regression: serving ${args.gamesRoot ? `repo root (games/ -> ${args.gamesRoot})` : 'repo root'} at ${served.baseURL}`);
    const { chromium } = require('playwright');
    browser = await chromium.launch(); // one shared instance for the whole suite
  }

  for (const m of selected) {
    const name = (m.mod && m.mod.name) || m.file;
    const game = (m.mod && m.mod.game) || '';
    const started = Date.now();
    let context = null;
    try {
      if (m.loadError) throw new Error(`failed to load module: ${m.loadError.message}`);
      if (!m.mod || typeof m.mod.run !== 'function' || typeof m.mod.name !== 'string' || typeof m.mod.game !== 'string') {
        throw new Error(`${m.file} does not export the { name, game, run } contract (see README.md)`);
      }
      context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      const openGame = makeOpenGame(page, served.baseURL);
      await withTimeout(m.mod.run({ page, openGame, assert }), TEST_TIMEOUT_MS, name);
      rows.push({ status: 'PASS', name, game, ms: Date.now() - started, detail: '' });
    } catch (err) {
      const ms = Date.now() - started;
      rows.push({ status: 'FAIL', name, game, ms, detail: firstLine(err.message) });
      console.error(`\nFAIL ${name} (${ms}ms)`);
      console.error(indent(err.stack || err.message || String(err)));
      // Best-effort: report the game state and snapshot at failure.
      if (context) {
        try {
          const pages = context.pages();
          const page = pages[pages.length - 1];
          const info = page && await withTimeout(
            page.evaluate(() => (window.__test
              ? { state: window.__test.state(), snapshot: window.__test.snapshot() }
              : null)),
            3000, 'state capture');
          if (info) {
            console.error(indent(`state at failure: ${info.state}`));
            console.error(indent(`snapshot at failure: ${JSON.stringify(info.snapshot)}`));
          } else {
            console.error(indent('state at failure: <no window.__test on page>'));
          }
        } catch (capErr) {
          console.error(indent(`state at failure: <capture failed: ${firstLine(capErr.message)}>`));
        }
      }
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // The budget/rig self-test (built by ticket t3 at a pinned path) is one row
  // of this suite. Absent file => SKIPPED with the reason, never a failure.
  if (selftestSelected) {
    const started = Date.now();
    if (fs.existsSync(BUDGET_SELFTEST)) {
      const res = spawnSync(process.execPath, [BUDGET_SELFTEST], { cwd: REPO_ROOT, encoding: 'utf8', timeout: TEST_TIMEOUT_MS });
      const ms = Date.now() - started;
      if (res.status === 0) {
        rows.push({ status: 'PASS', name: 'budget.selftest', game: '(tooling)', ms, detail: BUDGET_SELFTEST_REL });
      } else {
        rows.push({
          status: 'FAIL', name: 'budget.selftest', game: '(tooling)', ms,
          detail: `exit ${res.status === null ? `signal ${res.signal}` : res.status}`,
        });
        console.error(`\nFAIL budget.selftest (node ${BUDGET_SELFTEST_REL} exited ${res.status === null ? `on signal ${res.signal}` : res.status})`);
        if (res.stdout) console.error(indent(tail(res.stdout, 20)));
        if (res.stderr) console.error(indent(tail(res.stderr, 20)));
      }
    } else {
      rows.push({
        status: 'SKIP', name: 'budget.selftest', game: '(tooling)', ms: 0,
        detail: `${BUDGET_SELFTEST_REL} not present (ticket t3 not merged yet)`,
      });
    }
  }

  if (browser) await browser.close().catch(() => {});
  if (served) served.server.close();

  printTable(rows);
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const skipped = rows.filter((r) => r.status === 'SKIP').length;
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed > 0 ? 1 : 0;
}

function firstLine(s) { return String(s || '').split('\n')[0]; }
function indent(s) { return String(s).split('\n').map((l) => '  ' + l).join('\n'); }
function tail(s, n) { const lines = String(s).trimEnd().split('\n'); return lines.slice(-n).join('\n'); }

main().then(
  (code) => process.exit(code),
  (err) => { console.error('regression runner crashed:', err); process.exit(1); },
);
