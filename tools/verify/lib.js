'use strict';
/* =============================================================================
 * tools/verify/lib.js — shared plumbing for the four verifiers and their
 * runner (index.js). Everything here stays inside tools/verify/ on purpose
 * (ticket t3's boundary) — a little duplication with tools/playtest/ (a
 * parallel ticket) is the intended trade over a cross-directory helper.
 *
 * OWNS:
 *   - a tiny static HTTP file server on 127.0.0.1 (ephemeral port) — games
 *     are always served over http://, never file://
 *   - a `?test=1` page-open helper that waits until window.__test exists and
 *     the game has left LOADING
 *   - a generic snapshot deep-diff (flatten + compare), used by determinism.js
 *     for field-level mismatch reports and by journey.js to prove gameplay
 *     genuinely advanced
 *   - a generic table formatter
 *   - the standalone-CLI bootstrap (`node tools/verify/<verifier>.js <dir>`)
 *     each verifier uses to be runnable on its own, in addition to being
 *     `require()`d by index.js
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Game-dir argument handling — shared by index.js and every standalone CLI.
// ---------------------------------------------------------------------------

// Accepts a relative path (resolved against cwd), an absolute path, and a
// trailing slash (stripped before resolution).
function resolveGameDirArg(arg) {
  if (arg === undefined || arg === null || String(arg).trim() === '') {
    throw new Error('no game directory given');
  }
  let p = String(arg).trim();
  const stripped = p.replace(/[\\/]+$/, '');
  if (stripped !== '') p = stripped;
  return path.resolve(process.cwd(), p);
}

function validateGameDir(gameDir) {
  if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
    throw new Error(`game directory not found: ${gameDir}`);
  }
  const indexPath = path.join(gameDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`game directory has no index.html: ${indexPath}`);
  }
}

// Picks the HTTP serve root + URL path for a resolved game dir. Game dirs
// under the repo are served from the repo root itself (so relative asset
// paths inside a game work exactly as they will in the real repo); a game
// dir OUTSIDE the repo (used by negative-control testing against a mutated
// /tmp copy — see fixtures/README.md and the completion notes) is served
// from its own parent directory instead, so standalone verifiers work
// against arbitrary directories without ever touching file://.
function computeServeRoot(gameDirAbs) {
  const rel = path.relative(REPO_ROOT, gameDirAbs);
  const isInsideRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (isInsideRepo) {
    return { root: REPO_ROOT, urlPath: '/' + rel.split(path.sep).join('/') };
  }
  return { root: path.dirname(gameDirAbs), urlPath: '/' + path.basename(gameDirAbs) };
}

// ---------------------------------------------------------------------------
// Static HTTP server — 127.0.0.1, ephemeral port, no file://.
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

function startServer(root) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (_) {
      res.writeHead(400).end('bad request');
      return;
    }
    const normalized = path.posix.normalize(pathname);
    if (normalized.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const filePath = path.join(root, normalized);
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
// Page-open helper — appends ?test=1, waits until window.__test exists and
// state() has left LOADING. Every verifier opens pages through this, never
// directly through page.goto.
// ---------------------------------------------------------------------------
async function openTestPage(browser, baseURL, urlPath, opts = {}) {
  const page = await browser.newPage();
  const params = new URLSearchParams({ test: '1', ...(opts.query || {}) });
  const url = `${baseURL}${urlPath}/index.html?${params.toString()}`;
  const timeout = opts.timeout || 15000;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  try {
    await page.waitForFunction(
      () => window.__test &&
            typeof window.__test.state === 'function' &&
            window.__test.state() !== 'LOADING',
      null,
      { timeout },
    );
  } catch (e) {
    let state = '<unavailable>';
    try {
      state = await page.evaluate(() => (window.__test ? window.__test.state() : '<no window.__test>'));
    } catch (_) { /* page may already be gone */ }
    throw new Error(
      `openTestPage: window.__test did not appear or state stayed LOADING within ${timeout}ms ` +
      `at ${url} (state=${state})`);
  }
  return page;
}

// ---------------------------------------------------------------------------
// Snapshot deep-diff — flattens nested JSON-safe objects into dotted-path
// leaves, then compares. Used verbatim by determinism.js (exact-match field
// diff) and by journey.js (to prove which numeric field moved, or didn't).
// ---------------------------------------------------------------------------
function flatten(obj, prefix = '') {
  const out = {};
  if (obj === null || typeof obj !== 'object') {
    out[prefix || '(root)'] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, p));
    else out[p] = v;
  }
  return out;
}

// Exact field-level diff: every leaf path present in either object, flagged
// when the values are not Object.is-equal (NaN-safe, -0/+0 distinguishing —
// deliberately stricter than ==, since determinism must be EXACT).
function diffFlat(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const diffs = [];
  for (const k of [...keys].sort()) {
    if (!Object.is(fa[k], fb[k])) diffs.push({ path: k, a: fa[k], b: fb[k] });
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Table formatter — generic, column-defs + rows.
// ---------------------------------------------------------------------------
function printTable(cols, rows) {
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length), 0));
  const line = (cells) => '  ' + cells.map((s, i) => String(s).padEnd(widths[i])).join('  ').trimEnd();
  const sep = '  ' + widths.map((w) => '-'.repeat(w)).join('  ');
  const out = ['', line(cols.map((c) => c.header)), sep];
  for (const r of rows) out.push(line(cols.map((c) => c.get(r))));
  out.push(sep);
  console.log(out.join('\n'));
}

function firstLine(s) { return String(s == null ? '' : s).split('\n')[0]; }
function indent(s) { return String(s).split('\n').map((l) => '  ' + l).join('\n'); }
function tail(s, n) { const lines = String(s).trimEnd().split('\n'); return lines.slice(-n).join('\n'); }

// ---------------------------------------------------------------------------
// Standalone-CLI bootstrap — every verifier calls
// `if (require.main === module) lib.cliMain(module.exports);` at its tail.
// Builds its own context (server + browser, unless the verifier declares
// `needsBrowser: false`, which only budget.js does — pure filesystem work),
// runs it, prints PASS/FAIL with duration, and exits non-zero on failure.
// ---------------------------------------------------------------------------
async function cliMain(verifierModule) {
  const arg = process.argv[2];
  const selfName = verifierModule.name;
  if (!arg) {
    console.error(`usage: node tools/verify/${selfName}.js <game-dir>`);
    process.exit(1);
    return;
  }

  let gameDir;
  try {
    gameDir = resolveGameDirArg(arg);
    validateGameDir(gameDir);
  } catch (e) {
    console.error(`${selfName}: ${e.message}`);
    process.exit(1);
    return;
  }

  const needsBrowser = verifierModule.needsBrowser !== false;
  let browser = null;
  let server = null;
  let baseURL = null;
  let urlPath = null;

  if (needsBrowser) {
    const { chromium } = require('playwright');
    const rooted = computeServeRoot(gameDir);
    urlPath = rooted.urlPath;
    ({ server, baseURL } = await startServer(rooted.root));
    browser = await chromium.launch({ headless: true });
  }

  const ctx = {
    gameDir,
    browser,
    baseURL,
    urlPath,
    openPage: (opts) => openTestPage(browser, baseURL, urlPath, opts),
    loadBudgets: () => require('./budget').loadBudgets(gameDir),
  };

  const started = Date.now();
  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  };

  try {
    await verifierModule.run(ctx);
    console.log(`\nPASS ${selfName} (${Date.now() - started}ms)`);
    await cleanup();
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL ${selfName} (${Date.now() - started}ms)`);
    console.error(indent(e.stack || e.message || String(e)));
    await cleanup();
    process.exit(1);
  }
}

module.exports = {
  REPO_ROOT,
  resolveGameDirArg,
  validateGameDir,
  computeServeRoot,
  startServer,
  openTestPage,
  flatten,
  diffFlat,
  printTable,
  firstLine,
  indent,
  tail,
  cliMain,
};
