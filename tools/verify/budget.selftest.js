#!/usr/bin/env node
'use strict';
/* =============================================================================
 * tools/verify/budget.selftest.js — proves the DORMANT GLB/rig budget path in
 * budget.js against the tiny checked-in fixtures under tools/verify/fixtures/.
 *
 * Per the spec's non-goals: "the budget/rig checks ship dormant [because no
 * game today has assets/] and are proven by unit-testing budget.js against a
 * tiny checked-in GLB fixture under tools/verify/fixtures/." This is that
 * unit test. It calls budget.js's exported validateGlbAsset() DIRECTLY — no
 * browser, no server, no game dir — against each fixture, and asserts not
 * just pass/fail but the SPECIFIC check name expected to fail, so a fixture
 * that fails for the wrong reason is caught too.
 *
 * PINNED PATH + NO-ARGS CONTRACT: ticket t5's `npm run regression` invokes
 * exactly `node tools/verify/budget.selftest.js` with no arguments and reads
 * its exit code. Do not rename this file or require arguments.
 *
 * Run standalone: `node tools/verify/budget.selftest.js`
 * ========================================================================== */

const path = require('path');
const budget = require('./budget');
const lib = require('./lib');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Self-test-scoped budgets — deliberately tight so every fixture stays well
// under the ~7KB ceiling while still genuinely tripping its target check.
// These are NOT the shipped defaults (see budget.js's DEFAULT_BUDGETS, used
// by the real verifier when a game's budgets.json is absent/partial) — they
// exist purely to make small fixtures exercise real enforcement.
const SELFTEST_GLB_BUDGETS = {
  maxSingleFileBytes: 1048576, // unused by GLB checks; present for shape parity
  maxTotalDirBytes: 1048576,   // unused by GLB checks; present for shape parity
  glb: {
    maxTriangles: 500,
    maxFileBytes: 4096,
    requireRigCheck: true,
  },
};

// Each case: fixture file name (without .glb), the checks expected to PASS,
// and the checks expected to FAIL. Every check budget.js can produce must be
// named here (checks not listed default to "expected to pass").
const CASES = [
  {
    name: 'valid-triangle',
    expectOverallPass: true,
    expectFailingChecks: [],
  },
  {
    name: 'over-triangles',
    expectOverallPass: false,
    expectFailingChecks: ['triangleBudget'],
  },
  {
    name: 'over-filesize',
    expectOverallPass: false,
    expectFailingChecks: ['fileSize'],
  },
  {
    name: 'no-sidecar',
    expectOverallPass: false,
    // Missing sidecar cascades: everything that reads the sidecar is also
    // reported failing ("skipped: no sidecar"), but sidecarPresent is the
    // root cause this case is named for.
    expectFailingChecks: ['sidecarPresent', 'declaredTrianglesMatch', 'rigCheck', 'provenancePresent'],
  },
  {
    name: 'rig-failed',
    expectOverallPass: false,
    expectFailingChecks: ['rigCheck'],
  },
  {
    name: 'lying-sidecar',
    expectOverallPass: false,
    expectFailingChecks: ['declaredTrianglesMatch'],
  },
];

function checkByName(checks, name) {
  return checks.find((c) => c.name === name);
}

function runCase(testCase) {
  const glbPath = path.join(FIXTURES_DIR, `${testCase.name}.glb`);
  const result = budget.validateGlbAsset(glbPath, SELFTEST_GLB_BUDGETS);

  const problems = [];

  if (result.overallPass !== testCase.expectOverallPass) {
    problems.push(
      `overallPass: expected ${testCase.expectOverallPass}, got ${result.overallPass}`);
  }

  const actualFailingNames = result.checks.filter((c) => !c.pass).map((c) => c.name).sort();
  const expectedFailingNames = [...testCase.expectFailingChecks].sort();
  const actualSet = new Set(actualFailingNames);
  const expectedSet = new Set(expectedFailingNames);

  const missing = expectedFailingNames.filter((n) => !actualSet.has(n));
  const unexpected = actualFailingNames.filter((n) => !expectedSet.has(n));

  if (missing.length > 0) {
    problems.push(`expected these checks to FAIL but they passed: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    problems.push(`these checks FAILED but were not expected to: ${unexpected.join(', ')}`);
  }

  const detail = result.checks.map((c) => `${c.pass ? 'pass' : 'FAIL'}:${c.name}`).join(' ');

  return {
    name: testCase.name,
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    detail: problems.length === 0 ? detail : problems.join(' | '),
    checks: result.checks,
  };
}

function main() {
  console.log(`budget.selftest: validating ${CASES.length} GLB fixture(s) under ` +
    `${path.relative(lib.REPO_ROOT, FIXTURES_DIR)}/ against budget.js's shared GLB-validation logic\n`);

  const rows = [];
  for (const testCase of CASES) {
    let row;
    try {
      row = runCase(testCase);
    } catch (e) {
      row = { name: testCase.name, status: 'FAIL', detail: `threw: ${e.message}` };
    }
    rows.push(row);
    if (row.status === 'FAIL') {
      console.error(`FAIL ${row.name}`);
      console.error(lib.indent(row.detail));
      if (row.checks) {
        for (const c of row.checks) {
          console.error(lib.indent(`  [${c.pass ? 'pass' : 'FAIL'}] ${c.name}: ${c.detail}`));
        }
      }
    }
  }

  lib.printTable(
    [
      { header: 'RESULT', get: (r) => r.status },
      { header: 'FIXTURE', get: (r) => r.name },
      { header: 'DETAIL', get: (r) => r.detail },
    ],
    rows,
  );

  const failed = rows.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${rows.length - failed}/${rows.length} fixture cases behaved as expected`);
  return failed > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { CASES, SELFTEST_GLB_BUDGETS, runCase };
