// scripts/validate-mascots.test.mjs
//
// Tests for scripts/validate-mascots.mjs, run with
// `node --test scripts/validate-mascots.test.mjs`.
// Builds synthetic GLB buffers in memory / in a tmp dir — no real mascot
// assets are needed or used.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseGLB,
  countRenderedTriangles,
  validateDocument,
  validateFile,
} from './validate-mascots.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./validate-mascots.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

// ---------------------------------------------------------------------------
// GLB construction helpers
// ---------------------------------------------------------------------------

/** Build a well-formed GLB buffer (header + single JSON chunk) from a glTF document. */
function buildGLB(json) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const padding = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(padding, 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJson.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');

  return Buffer.concat([header, chunkHeader, paddedJson]);
}

/** A minimal, otherwise-passing glTF document: 1 skin, 1 animation, one
 * indexed triangle-mode primitive with 100 triangles (300 indices). */
function baseDoc() {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }],
      },
    ],
    accessors: [
      { count: 100, type: 'VEC3', componentType: 5126 }, // POSITION
      { count: 300, type: 'SCALAR', componentType: 5123 }, // indices -> 100 triangles
    ],
    skins: [{ joints: [0] }],
    animations: [{ channels: [], samplers: [] }],
  };
}

function withTriangleAccessorCount(indicesCount) {
  const doc = baseDoc();
  doc.accessors[1].count = indicesCount;
  return doc;
}

function tmpFile(buffer, name = 'asset.glb') {
  const dir = mkdtempSync(path.join(tmpdir(), 'mascot-validate-'));
  const file = path.join(dir, name);
  writeFileSync(file, buffer);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// Passing case
// ---------------------------------------------------------------------------

test('passing: skins >= 1, animations >= 1, triangles <= 10000', () => {
  const result = validateDocument(baseDoc());
  assert.equal(result.pass, true);
  assert.equal(result.skins, 1);
  assert.equal(result.animations, 1);
  assert.equal(result.triangles, 100);
  assert.deepEqual(result.errors, []);
});

test('passing end-to-end via validateFile on a real synthetic GLB file', () => {
  const { dir, file } = tmpFile(buildGLB(baseDoc()));
  try {
    const result = validateFile(file);
    assert.equal(result.pass, true);
    assert.equal(result.file, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 0 skins / 0 animations
// ---------------------------------------------------------------------------

test('fails with 0 skins', () => {
  const doc = baseDoc();
  doc.skins = [];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.skins, 0);
  assert.ok(result.errors.some((e) => e.includes('skins')));
});

test('fails with 0 animations', () => {
  const doc = baseDoc();
  doc.animations = [];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.animations, 0);
  assert.ok(result.errors.some((e) => e.includes('animations')));
});

test('fails when skins key is absent entirely', () => {
  const doc = baseDoc();
  delete doc.skins;
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.skins, 0);
});

test('fails when animations key is absent entirely', () => {
  const doc = baseDoc();
  delete doc.animations;
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.animations, 0);
});

// ---------------------------------------------------------------------------
// Triangle threshold: 10,000 passes, 10,001 fails
// ---------------------------------------------------------------------------

test('exactly 10,000 rendered triangles passes', () => {
  const doc = withTriangleAccessorCount(30000); // 30000 / 3 = 10000
  const result = validateDocument(doc);
  assert.equal(result.triangles, 10000);
  assert.equal(result.pass, true);
});

test('10,001 rendered triangles fails', () => {
  const doc = withTriangleAccessorCount(30003); // 30003 / 3 = 10001
  const result = validateDocument(doc);
  assert.equal(result.triangles, 10001);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('10001')));
});

// ---------------------------------------------------------------------------
// Non-indexed primitive (uses POSITION accessor count directly)
// ---------------------------------------------------------------------------

test('non-indexed triangle primitive uses POSITION accessor count', () => {
  const doc = baseDoc();
  delete doc.meshes[0].primitives[0].indices;
  doc.accessors[0].count = 30000; // POSITION count -> 30000/3 = 10000 triangles
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 10000);
});

// ---------------------------------------------------------------------------
// TRIANGLE_STRIP / TRIANGLE_FAN
// ---------------------------------------------------------------------------

test('TRIANGLE_STRIP (mode 5) contributes max(count - 2, 0)', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = 5;
  doc.accessors[1].count = 12; // strip of 12 indices -> 10 triangles
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 10);
});

test('TRIANGLE_FAN (mode 6) contributes max(count - 2, 0)', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = 6;
  doc.accessors[1].count = 12; // fan of 12 indices -> 10 triangles
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 10);
});

test('degenerate strip (count < 2) contributes 0, not negative', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = 5;
  doc.accessors[1].count = 1;
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 0);
});

test('point/line modes (0-3) contribute 0 triangles', () => {
  for (const mode of [0, 1, 2, 3]) {
    const doc = baseDoc();
    doc.meshes[0].primitives[0].mode = mode;
    assert.equal(countRenderedTriangles(doc), 0, `mode ${mode} should contribute 0`);
  }
});

// ---------------------------------------------------------------------------
// Mesh instancing
// ---------------------------------------------------------------------------

test('a mesh instanced by two nodes counts twice', () => {
  const doc = baseDoc(); // mesh 0 has 100 triangles
  doc.nodes = [{ mesh: 0 }, { mesh: 0 }];
  doc.scenes = [{ nodes: [0, 1] }];
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 200);
});

test('a mesh referenced by a node outside any scene still counts', () => {
  const doc = baseDoc();
  // Two nodes reference mesh 0; only node 0 is in the scene's node list.
  doc.nodes = [{ mesh: 0 }, { mesh: 0 }];
  doc.scenes = [{ nodes: [0] }]; // node 1 is unreachable from the scene graph
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 200, 'node lists count regardless of scene membership');
});

// ---------------------------------------------------------------------------
// Unreferenced mesh
// ---------------------------------------------------------------------------

test('a mesh with no referencing node still counts once', () => {
  const doc = baseDoc(); // mesh 0 (100 triangles) referenced by node 0
  doc.meshes.push({
    primitives: [{ attributes: { POSITION: 2 }, indices: 3, mode: 4 }],
  });
  doc.accessors.push(
    { count: 60, type: 'VEC3', componentType: 5126 }, // POSITION for mesh 1
    { count: 60, type: 'SCALAR', componentType: 5123 } // indices -> 20 triangles
  );
  // No node references mesh index 1.
  const triangles = countRenderedTriangles(doc);
  assert.equal(triangles, 100 + 20);
});

// ---------------------------------------------------------------------------
// Bad magic
// ---------------------------------------------------------------------------

test('rejects bad magic with a clear error', () => {
  const buffer = buildGLB(baseDoc());
  buffer.write('FAKE', 0, 'ascii');
  assert.throws(() => parseGLB(buffer), /bad magic/);
});

test('validateFile reports bad-magic files as a clear failure, not a throw', () => {
  const buffer = buildGLB(baseDoc());
  buffer.write('FAKE', 0, 'ascii');
  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('bad magic')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects wrong version with a clear error', () => {
  const buffer = buildGLB(baseDoc());
  buffer.writeUInt32LE(1, 4); // version 1 instead of 2
  assert.throws(() => parseGLB(buffer), /version/);
});

test('rejects a first chunk that is not JSON', () => {
  const buffer = buildGLB(baseDoc());
  buffer.write('BIN\u0000', 16, 'ascii'); // overwrite chunk type
  assert.throws(() => parseGLB(buffer), /not JSON/);
});

// ---------------------------------------------------------------------------
// Truncated file
// ---------------------------------------------------------------------------

test('rejects a truncated file (fewer than 12 header bytes)', () => {
  const buffer = buildGLB(baseDoc()).subarray(0, 8);
  assert.throws(() => parseGLB(buffer), /truncated/);
});

test('rejects a file truncated mid-JSON-chunk', () => {
  const full = buildGLB(baseDoc());
  const buffer = full.subarray(0, full.length - 10);
  assert.throws(() => parseGLB(buffer), /truncated/);
});

test('validateFile reports truncated files as a clear failure, not a throw', () => {
  const full = buildGLB(baseDoc());
  const truncated = full.subarray(0, full.length - 10);
  const { dir, file } = tmpFile(truncated);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('truncated')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

test('a missing file is reported as a failure, not a throw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mascot-validate-'));
  const missing = path.join(dir, 'does-not-exist.glb');
  try {
    const result = validateFile(missing);
    assert.equal(result.pass, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('missing file')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CRUCIAL fix: triangle-gate bypass through malformed accessor/mode values
// (round-2 reviewer finding). Every value feeding the triangle count must be
// strictly validated, and the file must FAIL (a reported failure, not a
// throw at the top level) on any violation.
// ---------------------------------------------------------------------------

test('accessor count missing (undefined) fails, not NaN-passes', () => {
  const doc = baseDoc();
  delete doc.accessors[1].count; // indices accessor with no count at all
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(Number.isNaN(result.triangles) === false, 'triangles must not be NaN in the result');
  assert.ok(
    result.errors.some((e) => e.includes('could not compute triangle count')),
    `expected a triangle-count error, got: ${JSON.stringify(result.errors)}`
  );
});

test('accessor count as a non-numeric string fails, not NaN-passes', () => {
  const doc = baseDoc();
  doc.accessors[1].count = 'lots'; // string count -> would coerce to NaN
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('negative accessor count fails instead of subtracting from the total', () => {
  // Real payload would be ~30,000 indices (10,000 triangles); a negative
  // count must not be allowed to cancel it out to 0/pass.
  const doc = baseDoc();
  doc.accessors[1].count = -90000;
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(
    result.errors.some((e) => e.includes('could not compute triangle count')),
    `expected a triangle-count error, got: ${JSON.stringify(result.errors)}`
  );
});

test('primitive mode as a string ("4") fails instead of silently counting 0', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = '4';
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('primitive mode out of range (7) fails', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = 7;
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('primitive mode as a non-integer number (4.5) fails', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].mode = 4.5;
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('out-of-range indices accessor index fails instead of throwing uncaught', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].indices = 99; // no accessor 99
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('out-of-range node.mesh index fails instead of throwing uncaught', () => {
  const doc = baseDoc();
  doc.nodes = [{ mesh: 99 }];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('could not compute triangle count')));
});

test('manager repro: NaN/negative/string-mode files all FAIL, not PASS', () => {
  // Mirrors the exact reproduction from the round-2 order: three malformed
  // synthetic GLBs that used to report "3/3 passed" and exit 0.
  const base = {
    asset: { version: '2.0' },
    skins: [{ joints: [0] }],
    animations: [{ channels: [], samplers: [] }],
    nodes: [{ mesh: 0 }],
  };
  const positionAccessor = { componentType: 5126, type: 'VEC3', count: 3 };

  const nanDoc = {
    ...base,
    accessors: [
      positionAccessor,
      { componentType: 5125, type: 'SCALAR', count: 150000 },
      { componentType: 5125, type: 'SCALAR' }, // count missing -> NaN today
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1 },
          { attributes: { POSITION: 0 }, indices: 2 },
        ],
      },
    ],
  };

  const negDoc = {
    ...base,
    accessors: [
      positionAccessor,
      { componentType: 5125, type: 'SCALAR', count: 90000 },
      { componentType: 5125, type: 'SCALAR', count: -90000 },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1 },
          { attributes: { POSITION: 0 }, indices: 2 },
        ],
      },
    ],
  };

  const modeStrDoc = {
    ...base,
    accessors: [{ ...positionAccessor, count: 90000 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: '4' }] }],
  };

  for (const doc of [nanDoc, negDoc, modeStrDoc]) {
    const result = validateDocument(doc);
    assert.equal(result.pass, false, `expected FAIL, got PASS for ${JSON.stringify(doc.accessors)}`);
  }
});

// ---------------------------------------------------------------------------
// Hardening (i): CLI guard false green through a symlinked invocation path
// ---------------------------------------------------------------------------

test('invoking the CLI through a symlinked path actually runs it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mascot-validate-symlink-'));
  const linkPath = path.join(dir, 'validate-mascots-link.mjs');
  try {
    symlinkSync(SCRIPT_PATH, linkPath);

    // Point the CLI at a synthetic passing file so this test doesn't depend
    // on the real mascot assets being present.
    const { dir: fileDir, file } = tmpFile(buildGLB(baseDoc()));
    try {
      const result = spawnSync(process.execPath, [linkPath, file], { encoding: 'utf8' });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.trim().length > 0, 'expected non-empty stdout from the CLI run');
      assert.ok(result.stdout.includes('PASS'), `expected a PASS line, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('1/1 passed'), `expected a summary line, got: ${result.stdout}`);
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  } finally {
    if (existsSync(linkPath)) unlinkSync(linkPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hardening (ii): a JSON chunk that parses to a non-object must be a
// reported per-file FAIL, not an uncaught throw that aborts other files.
// ---------------------------------------------------------------------------

function buildGLBFromRawJSONText(jsonText) {
  const jsonBuffer = Buffer.from(jsonText, 'utf8');
  const padding = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(padding, 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJson.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');

  return Buffer.concat([header, chunkHeader, paddedJson]);
}

for (const [label, rawJSON] of [
  ['null', 'null'],
  ['a number', '42'],
  ['an array', '[1,2,3]'],
]) {
  test(`a JSON chunk that parses to ${label} is a reported FAIL, not a throw`, () => {
    const buffer = buildGLBFromRawJSONText(rawJSON);
    const { dir, file } = tmpFile(buffer);
    try {
      let result;
      assert.doesNotThrow(() => {
        result = validateFile(file);
      });
      assert.equal(result.pass, false);
      assert.ok(result.errors.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a non-object JSON chunk in one file does not abort validation of the rest', () => {
  const { dir: dir1, file: badFile } = tmpFile(buildGLBFromRawJSONText('null'), 'bad.glb');
  const { dir: dir2, file: goodFile } = tmpFile(buildGLB(baseDoc()), 'good.glb');
  try {
    const results = [badFile, goodFile].map(validateFile);
    assert.equal(results[0].pass, false);
    assert.equal(results[1].pass, true);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hardening (iii): GLB container strictness
// ---------------------------------------------------------------------------

test('rejects a GLB whose declared total length is longer than the actual file', () => {
  const buffer = buildGLB(baseDoc());
  buffer.writeUInt32LE(buffer.length + 100, 8); // declare more than we have
  assert.throws(() => parseGLB(buffer), /truncated/);
});

test('rejects a GLB whose declared total length is shorter than the actual file (trailing data)', () => {
  const buffer = buildGLB(baseDoc());
  const withTrailingJunk = Buffer.concat([buffer, Buffer.alloc(16, 0)]);
  // Header still declares the original (shorter) length.
  assert.throws(() => parseGLB(withTrailingJunk), /length/i);
});

test('rejects a GLB whose JSON chunk extends past the declared total length', () => {
  const buffer = buildGLB(baseDoc());
  // Inflate only the chunk-length field (not the actual byte count, not the
  // header's declared total length), so the top-level length check still
  // passes and only the chunk-vs-declared-length check can catch this.
  const chunkLengthOffset = 12;
  const originalChunkLength = buffer.readUInt32LE(chunkLengthOffset);
  buffer.writeUInt32LE(originalChunkLength + 8, chunkLengthOffset);
  assert.throws(() => parseGLB(buffer), /truncated|declared/i);
});

test('rejects a GLB whose JSON chunk length is not a multiple of 4', () => {
  const jsonBuffer = Buffer.from(JSON.stringify(baseDoc()), 'utf8');
  // Deliberately do NOT pad to a multiple of 4.
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuffer.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonBuffer.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');

  const buffer = Buffer.concat([header, chunkHeader, jsonBuffer]);
  // Only construct this malformed buffer if the JSON text itself doesn't
  // happen to already be a multiple of 4 bytes (it isn't, for baseDoc()).
  assert.notEqual(jsonBuffer.length % 4, 0, 'test fixture assumption: unpadded length not a multiple of 4');
  assert.throws(() => parseGLB(buffer), /multiple of 4/);
});

test('the three real mascot assets still pass after the container-strictness hardening', () => {
  for (const name of ['crab.glb', 'gull.glb', 'buoy.glb']) {
    const assetPath = path.join(REPO_ROOT, 'assets', 'mascots', name);
    if (!existsSync(assetPath)) {
      // Real binary assets may not be present in every checkout context;
      // skip rather than fail if so.
      continue;
    }
    const result = validateFile(assetPath);
    assert.equal(result.pass, true, `expected ${name} to PASS, got errors: ${JSON.stringify(result.errors)}`);
  }
});

// ---------------------------------------------------------------------------
// Hardening (iv): a skin without joints is schema-invalid (malformed)
// ---------------------------------------------------------------------------

test('a skin with an empty joints array fails', () => {
  const doc = baseDoc();
  doc.skins = [{ joints: [] }];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('joints')));
});

test('a skin with a missing joints array fails', () => {
  const doc = baseDoc();
  doc.skins = [{}];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(result.errors.some((e) => e.includes('joints')));
});

test('a skin with a non-empty joints array still passes (no other new gates)', () => {
  const doc = baseDoc();
  doc.skins = [{ joints: [0, 1, 2] }];
  const result = validateDocument(doc);
  assert.equal(result.pass, true);
});
