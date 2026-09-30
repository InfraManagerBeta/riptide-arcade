'use strict';
/* =============================================================================
 * tools/verify/budget.js — enforces per-game budgets from budgets.json
 * (defaults here when absent/partial). No Playwright needed: pure filesystem
 * + a from-scratch binary GLB/JSON-chunk parser (no rendering, no 3D lib).
 *
 * ALWAYS CHECKED:
 *   - largest single file in the game dir
 *   - total dir size (excludes playtest-report/ — generated, git-ignored)
 *
 * CHECKED ONLY WHEN THE GAME DIR HAS assets/ (dormant for every game today —
 * spec's non-goal: "no 3D assets yet ... proven by unit-testing budget.js
 * against a tiny checked-in GLB fixture"; see fixtures/ + budget.selftest.js):
 *   for each .glb under assets/: parse the 12-byte header + JSON chunk only,
 *   compute triangle count from accessor/primitive data, enforce maxTriangles
 *   + maxFileBytes, require a sidecar <asset>.glb.meta.json carrying
 *   provenance + a declared triangle count + a rig-check status; when
 *   requireRigCheck is true the rig status must be "clean" (case-insensitive)
 *   and a declared triangle count that contradicts the parsed count by more
 *   than 2% (floored at 1 triangle) fails — the "lying sidecar" bug class.
 *
 * Exported functions are reused verbatim by budget.selftest.js so the exact
 * same GLB-validation logic that runs in `npm run verify` is what gets
 * proven against the checked-in fixtures.
 *
 * Standalone: `node tools/verify/budget.js <game-dir>` (no browser needed:
 * needsBrowser = false below).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// ---------------------------------------------------------------------------
// Budget defaults — fail-closed (requireRigCheck defaults true).
// ---------------------------------------------------------------------------
const DEFAULT_BUDGETS = {
  maxSingleFileBytes: 262144,   // 256 KiB
  maxTotalDirBytes: 1048576,    // 1 MiB
  glb: {
    maxTriangles: 20000,
    maxFileBytes: 2097152,      // 2 MiB
    requireRigCheck: true,
  },
};

const EXCLUDED_DIR_NAMES = ['playtest-report']; // generated output, git-ignored

function loadBudgets(gameDir) {
  const p = path.join(gameDir, 'budgets.json');
  let user = {};
  if (fs.existsSync(p)) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      throw new Error(`budgets.json: could not read ${p} (${e.message})`);
    }
    try {
      user = JSON.parse(raw);
    } catch (e) {
      throw new Error(`budgets.json: invalid JSON in ${p} (${e.message})`);
    }
  }
  const userGlb = user.glb || {};
  return {
    maxSingleFileBytes: numOr(user.maxSingleFileBytes, DEFAULT_BUDGETS.maxSingleFileBytes),
    maxTotalDirBytes: numOr(user.maxTotalDirBytes, DEFAULT_BUDGETS.maxTotalDirBytes),
    glb: {
      maxTriangles: numOr(userGlb.maxTriangles, DEFAULT_BUDGETS.glb.maxTriangles),
      maxFileBytes: numOr(userGlb.maxFileBytes, DEFAULT_BUDGETS.glb.maxFileBytes),
      requireRigCheck: typeof userGlb.requireRigCheck === 'boolean'
        ? userGlb.requireRigCheck
        : DEFAULT_BUDGETS.glb.requireRigCheck,
    },
  };
}

function numOr(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }

// ---------------------------------------------------------------------------
// File-size checks — always run.
// ---------------------------------------------------------------------------
function walkFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.includes(entry.name)) continue;
        walk(abs, relPath);
      } else if (entry.isFile()) {
        out.push({ abs, rel: relPath, size: fs.statSync(abs).size });
      }
    }
  })(dir, '');
  return out;
}

function computeSizeFacts(gameDir) {
  const files = walkFiles(gameDir);
  let totalSize = 0;
  let largest = null;
  for (const f of files) {
    totalSize += f.size;
    if (!largest || f.size > largest.size) largest = f;
  }
  return { files, totalSize, largest };
}

// ---------------------------------------------------------------------------
// GLB parsing — 12-byte header + chunks; only the JSON chunk is inspected.
// No rendering, no 3D library, no new dependency.
// ---------------------------------------------------------------------------
function parseGlb(buffer) {
  if (buffer.length < 12) throw new Error(`GLB too small for header (${buffer.length} bytes, need >= 12)`);
  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== 'glTF') throw new Error(`bad GLB magic: ${JSON.stringify(magic)} (expected "glTF")`);
  const version = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(8);

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length && offset < length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > buffer.length) {
      throw new Error(`GLB chunk overruns file: declared length ${chunkLength} at offset ${offset}`);
    }
    chunks.push({ type: chunkType, data: buffer.slice(dataStart, dataEnd) });
    offset = dataEnd;
    if (offset % 4 !== 0) offset += 4 - (offset % 4); // chunks are 4-byte aligned
  }

  const jsonChunk = chunks.find((c) => c.type === 'JSON') || chunks[0];
  if (!jsonChunk) throw new Error('GLB has no chunks (expected at least a JSON chunk)');
  let json;
  try {
    json = JSON.parse(jsonChunk.data.toString('utf8'));
  } catch (e) {
    throw new Error(`GLB JSON chunk is not valid JSON: ${e.message}`);
  }
  return { version, length, json };
}

// Sums triangles across every TRIANGLES-mode primitive in every mesh. Uses
// the index accessor's count when indexed, else the POSITION accessor's
// vertex count — either way divided by 3. Non-triangle primitive modes
// (points/lines/strips/fans) are skipped: this tool enforces budgets, it
// does not need to fully implement gltf rendering semantics.
const GLTF_MODE_TRIANGLES = 4; // default per spec when `mode` is omitted
function countTriangles(json) {
  let total = 0;
  const accessors = json.accessors || [];
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const mode = prim.mode === undefined ? GLTF_MODE_TRIANGLES : prim.mode;
      if (mode !== GLTF_MODE_TRIANGLES) continue;
      let vertCount;
      if (prim.indices !== undefined) {
        const acc = accessors[prim.indices];
        if (!acc) throw new Error(`primitive references missing index accessor #${prim.indices}`);
        vertCount = acc.count;
      } else if (prim.attributes && prim.attributes.POSITION !== undefined) {
        const acc = accessors[prim.attributes.POSITION];
        if (!acc) throw new Error(`primitive references missing POSITION accessor #${prim.attributes.POSITION}`);
        vertCount = acc.count;
      } else {
        throw new Error('primitive has neither `indices` nor a POSITION attribute');
      }
      total += Math.floor(vertCount / 3);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Sidecar metadata — `<asset>.glb` -> `<asset>.glb.meta.json` (matches the
// worked example in docs/spec-template.md).
// ---------------------------------------------------------------------------
function sidecarPathFor(glbPath) { return `${glbPath}.meta.json`; }

function loadSidecar(glbPath) {
  const sidecarPath = sidecarPathFor(glbPath);
  if (!fs.existsSync(sidecarPath)) return { exists: false, path: sidecarPath };
  let raw;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch (e) {
    return { exists: true, path: sidecarPath, parseError: `could not read: ${e.message}` };
  }
  try {
    return { exists: true, path: sidecarPath, meta: JSON.parse(raw) };
  } catch (e) {
    return { exists: true, path: sidecarPath, parseError: `invalid JSON: ${e.message}` };
  }
}

function triangleTolerance(declared) { return Math.max(1, Math.ceil(declared * 0.02)); }

function mkCheck(name, pass, detail) { return { name, pass, detail }; }

// The full per-asset validation: file size, GLB parse, triangle budget,
// sidecar presence/parse, declared-vs-parsed triangle agreement, rig status,
// provenance presence. Returns { path, triangleCount, fileSize, checks[],
// overallPass } — reused as-is by budget.selftest.js.
function validateGlbAsset(glbPath, budgets) {
  const checks = [];

  let fileSize = null;
  try {
    fileSize = fs.statSync(glbPath).size;
    checks.push(mkCheck('fileSize', fileSize <= budgets.glb.maxFileBytes,
      `${fileSize}B <= ${budgets.glb.maxFileBytes}B limit`));
  } catch (e) {
    checks.push(mkCheck('fileSize', false, `could not stat file: ${e.message}`));
  }

  let triangleCount = null;
  let parseError = null;
  try {
    const buf = fs.readFileSync(glbPath);
    const parsed = parseGlb(buf);
    triangleCount = countTriangles(parsed.json);
  } catch (e) {
    parseError = e.message;
  }
  checks.push(mkCheck('glbParse', parseError === null, parseError || 'GLB header + JSON chunk parsed OK'));

  if (triangleCount !== null) {
    checks.push(mkCheck('triangleBudget', triangleCount <= budgets.glb.maxTriangles,
      `${triangleCount} <= ${budgets.glb.maxTriangles} limit (parsed from GLB)`));
  } else {
    checks.push(mkCheck('triangleBudget', false, 'skipped: GLB did not parse'));
  }

  const sidecar = loadSidecar(glbPath);
  if (!sidecar.exists) {
    checks.push(mkCheck('sidecarPresent', false, `missing sidecar: ${path.basename(sidecar.path)}`));
    checks.push(mkCheck('declaredTrianglesMatch', false, 'skipped: no sidecar'));
    checks.push(mkCheck('rigCheck', false, 'skipped: no sidecar'));
    checks.push(mkCheck('provenancePresent', false, 'skipped: no sidecar'));
  } else if (sidecar.parseError) {
    checks.push(mkCheck('sidecarPresent', false, `sidecar unparseable (${path.basename(sidecar.path)}): ${sidecar.parseError}`));
    checks.push(mkCheck('declaredTrianglesMatch', false, 'skipped: sidecar unparseable'));
    checks.push(mkCheck('rigCheck', false, 'skipped: sidecar unparseable'));
    checks.push(mkCheck('provenancePresent', false, 'skipped: sidecar unparseable'));
  } else {
    checks.push(mkCheck('sidecarPresent', true, path.basename(sidecar.path)));

    const declared = sidecar.meta.declaredTriangles;
    if (typeof declared === 'number' && triangleCount !== null) {
      const tolerance = triangleTolerance(declared);
      const within = Math.abs(declared - triangleCount) <= tolerance;
      checks.push(mkCheck('declaredTrianglesMatch', within,
        `declared=${declared} parsed=${triangleCount} tolerance=\u00b1${tolerance} (2%, floor 1)`));
    } else if (triangleCount === null) {
      checks.push(mkCheck('declaredTrianglesMatch', false, 'skipped: GLB did not parse'));
    } else {
      checks.push(mkCheck('declaredTrianglesMatch', false,
        `sidecar.declaredTriangles missing/not a number (got ${JSON.stringify(declared)})`));
    }

    const rigStatus = sidecar.meta.rigStatus;
    if (budgets.glb.requireRigCheck) {
      const clean = typeof rigStatus === 'string' && rigStatus.toLowerCase() === 'clean';
      checks.push(mkCheck('rigCheck', clean,
        `rigStatus=${JSON.stringify(rigStatus)} — requireRigCheck=true needs exactly "clean" (case-insensitive)`));
    } else {
      checks.push(mkCheck('rigCheck', true, `rigStatus=${JSON.stringify(rigStatus)} (requireRigCheck=false, not enforced)`));
    }

    const prov = sidecar.meta.provenance;
    const hasProvenance = !!(prov && typeof prov === 'object' && prov.tool && prov.model);
    checks.push(mkCheck('provenancePresent', hasProvenance,
      hasProvenance
        ? `provenance.tool=${JSON.stringify(prov.tool)} provenance.model=${JSON.stringify(prov.model)}`
        : `provenance missing/incomplete (need at least tool + model): ${JSON.stringify(prov)}`));
  }

  const overallPass = checks.every((c) => c.pass);
  return { path: glbPath, triangleCount, fileSize, checks, overallPass };
}

function findGlbFiles(gameDir) {
  const assetsDir = path.join(gameDir, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) out.push(abs);
    }
  })(assetsDir);
  return out;
}

// ---------------------------------------------------------------------------
// Verifier entry point.
// ---------------------------------------------------------------------------
async function run(ctx) {
  const gameDir = ctx.gameDir;
  const budgets = loadBudgets(gameDir);
  const { totalSize, largest } = computeSizeFacts(gameDir);

  const rows = [];
  const failures = [];

  const largestSize = largest ? largest.size : 0;
  const largestPass = largestSize <= budgets.maxSingleFileBytes;
  rows.push({
    check: 'largest single file',
    actual: `${largestSize}B (${largest ? largest.rel : '-'})`,
    limit: `${budgets.maxSingleFileBytes}B`,
    headroom: `${budgets.maxSingleFileBytes - largestSize}B`,
    result: largestPass ? 'PASS' : 'FAIL',
  });
  if (!largestPass) {
    failures.push(
      `largest single file exceeds budget: ${largest.rel} is ${largestSize}B, ` +
      `limit is ${budgets.maxSingleFileBytes}B (over by ${largestSize - budgets.maxSingleFileBytes}B)`);
  }

  const totalPass = totalSize <= budgets.maxTotalDirBytes;
  rows.push({
    check: 'total dir size',
    actual: `${totalSize}B`,
    limit: `${budgets.maxTotalDirBytes}B`,
    headroom: `${budgets.maxTotalDirBytes - totalSize}B`,
    result: totalPass ? 'PASS' : 'FAIL',
  });
  if (!totalPass) {
    failures.push(
      `total dir size exceeds budget: ${totalSize}B, limit is ${budgets.maxTotalDirBytes}B ` +
      `(over by ${totalSize - budgets.maxTotalDirBytes}B, excludes playtest-report/)`);
  }

  const glbFiles = findGlbFiles(gameDir);
  if (glbFiles.length === 0) {
    rows.push({ check: 'GLB assets', actual: 'no assets/ dir (dormant)', limit: '-', headroom: '-', result: 'PASS' });
  } else {
    for (const glbPath of glbFiles) {
      const result = validateGlbAsset(glbPath, budgets);
      const rel = path.relative(gameDir, glbPath);
      for (const c of result.checks) {
        rows.push({
          check: `${rel}: ${c.name}`,
          actual: c.detail,
          limit: '-',
          headroom: '-',
          result: c.pass ? 'PASS' : 'FAIL',
        });
      }
      if (!result.overallPass) {
        failures.push(
          `${rel} failed GLB budget/rig checks:\n` +
          result.checks.filter((c) => !c.pass).map((c) => `    [${c.name}] ${c.detail}`).join('\n'));
      }
    }
  }

  lib.printTable(
    [
      { header: 'RESULT', get: (r) => r.result },
      { header: 'CHECK', get: (r) => r.check },
      { header: 'ACTUAL', get: (r) => r.actual },
      { header: 'LIMIT', get: (r) => r.limit },
      { header: 'HEADROOM', get: (r) => r.headroom },
    ],
    rows,
  );

  if (failures.length > 0) {
    throw new Error(`budget: ${failures.length} check(s) failed:\n` + failures.map((f) => `  - ${f}`).join('\n'));
  }
}

module.exports = {
  name: 'budget',
  run,
  needsBrowser: false, // pure filesystem work — no page, no server needed
  // Reused by budget.selftest.js against the checked-in GLB fixtures:
  DEFAULT_BUDGETS,
  loadBudgets,
  parseGlb,
  countTriangles,
  validateGlbAsset,
  sidecarPathFor,
  triangleTolerance,
};

if (require.main === module) lib.cliMain(module.exports);
