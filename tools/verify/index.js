#!/usr/bin/env node
'use strict';
/* =============================================================================
 * tools/verify/index.js — the runner behind `npm run verify -- <game-dir>`.
 *
 * Runs all four verifiers in order (smoke, journey, determinism, budget),
 * EACH FULLY — one failure never hides the others. Prints a per-verifier
 * PASS/FAIL summary table with durations. Exit code non-zero if ANY verifier
 * failed, zero only if all four passed.
 *
 * Owns ONE shared static server + ONE shared Playwright chromium instance
 * across the four verifiers (budget.js needs neither) to keep the whole run
 * brisk, per the CI 5-minute budget.
 *
 * Usage: node tools/verify/index.js <game-dir>   (wired as `npm run verify --`)
 *   <game-dir> — relative to cwd, absolute, or with a trailing slash; must
 *   exist and contain index.html. No game dir given -> usage + exit 1.
 * ========================================================================== */

const lib = require('./lib');

const VERIFIER_NAMES = ['smoke', 'journey', 'determinism', 'budget'];

function printUsage() {
  console.log('usage: npm run verify -- <game-dir>');
  console.log('  <game-dir>   path to a game directory containing index.html');
  console.log('               (relative to cwd, absolute, or with a trailing slash)');
  console.log('example: npm run verify -- games/fixture-pong');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    printUsage();
    return 1;
  }

  let gameDir;
  try {
    gameDir = lib.resolveGameDirArg(arg);
    lib.validateGameDir(gameDir);
  } catch (e) {
    console.error(`verify: ${e.message}`);
    printUsage();
    return 1;
  }

  const { chromium } = require('playwright');
  const rooted = lib.computeServeRoot(gameDir);
  const { server, baseURL } = await lib.startServer(rooted.root);
  const browser = await chromium.launch({ headless: true });

  console.log(`verify: game dir ${gameDir}`);
  console.log(`verify: serving ${rooted.root} at ${baseURL} (game at ${rooted.urlPath}/index.html)`);

  const ctx = {
    gameDir,
    browser,
    baseURL,
    urlPath: rooted.urlPath,
    openPage: (opts) => lib.openTestPage(browser, baseURL, rooted.urlPath, opts),
    loadBudgets: () => require('./budget').loadBudgets(gameDir),
  };

  const rows = [];
  for (const name of VERIFIER_NAMES) {
    const mod = require(`./${name}`);
    console.log(`\n::group:: ${name}`);
    const started = Date.now();
    try {
      await mod.run(ctx);
      const ms = Date.now() - started;
      rows.push({ status: 'PASS', name, ms, detail: '' });
      console.log(`PASS ${name} (${ms}ms)`);
    } catch (e) {
      const ms = Date.now() - started;
      rows.push({ status: 'FAIL', name, ms, detail: lib.firstLine(e.message) });
      console.error(`FAIL ${name} (${ms}ms)`);
      console.error(lib.indent(e.stack || e.message || String(e)));
    }
    console.log('::endgroup::');
  }

  await browser.close().catch(() => {});
  server.close();

  lib.printTable(
    [
      { header: 'RESULT', get: (r) => r.status },
      { header: 'VERIFIER', get: (r) => r.name },
      { header: 'DURATION', get: (r) => `${r.ms}ms` },
      { header: 'DETAIL', get: (r) => r.detail },
    ],
    rows,
  );

  const failed = rows.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${rows.length - failed}/${rows.length} verifiers passed`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error('verify: runner crashed:', err); process.exit(1); },
);
