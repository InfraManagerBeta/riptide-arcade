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
  primitiveTriangleCount,
  validateDocument,
  validateShape,
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

/**
 * Low-level GLB builder that allows constructing malformed containers on
 * purpose: each entry in `chunks` gets an 8-byte chunk header (4-byte
 * length + 4-byte type) followed by `data`, where the length field can be
 * independently overridden from the actual byte count of `data` via
 * `lengthOverride`. `extraTrailingBytes`, when given, is appended raw after
 * all chunks (unaccounted-for trailing bytes). `declaredLengthOverride`
 * overrides the top-level header's declared total length; by default it is
 * the actual total byte count.
 *
 * @param {{chunks: {type:string, data:Buffer, lengthOverride?:number}[], extraTrailingBytes?: Buffer, declaredLengthOverride?: number}} opts
 * @returns {Buffer}
 */
function buildGLBRaw({ chunks, extraTrailingBytes, declaredLengthOverride }) {
  const chunkBuffers = chunks.map(({ type, data, lengthOverride }) => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(lengthOverride !== undefined ? lengthOverride : data.length, 0);
    chunkHeader.write(type, 4, 'ascii');
    return Buffer.concat([chunkHeader, data]);
  });
  const body = Buffer.concat([...chunkBuffers, ...(extraTrailingBytes ? [extraTrailingBytes] : [])]);
  const totalLength = declaredLengthOverride !== undefined ? declaredLengthOverride : 12 + body.length;

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  return Buffer.concat([header, body]);
}

/** A padded (multiple-of-4) JSON chunk data buffer for a glTF document, padded with ASCII spaces (0x20) per the GLB spec. */
function jsonChunkData(json) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const padding = (4 - (jsonBuffer.length % 4)) % 4;
  return Buffer.concat([jsonBuffer, Buffer.alloc(padding, 0x20)]);
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
// Round 4 CRUCIAL fix: a triangle primitive with no POSITION attribute is a
// valid glTF document (the schema does not require POSITION; clients skip
// rendering such a primitive per spec §3.7.2.1). It must contribute 0
// rendered triangles and must never FAIL the file on that basis alone,
// whether or not `indices` is present. A malformed `mode`, or an
// out-of-range `indices` index, still FAILs exactly as it does for any
// other primitive.
// ---------------------------------------------------------------------------

test('manager repro: a POSITION-less NORMAL-only primitive no longer throws / FAILs the file', () => {
  // Mirrors the exact manager repro at the CLI level: one skin, one
  // animation, one rendered triangle (mesh 0, POSITION-bearing) plus a
  // second mesh (mesh 1) whose sole primitive has only a NORMAL attribute
  // and no `indices` at all. Before round 4 this threw "primitive has no
  // indices and no POSITION attribute" and FAILed the whole file.
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'joint' }, { mesh: 0 }, { mesh: 1 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] }, // 3 verts, non-indexed -> 1 triangle
      { primitives: [{ attributes: { NORMAL: 1 } }] }, // no POSITION -> 0 triangles, not an error
    ],
    skins: [{ joints: [0] }],
    animations: [{ samplers: [{ input: 2, output: 3 }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }],
    accessors: [
      { componentType: 5126, count: 3, type: 'VEC3' }, // POSITION
      { componentType: 5126, count: 3, type: 'VEC3' }, // NORMAL
      { componentType: 5126, count: 2, type: 'SCALAR' }, // animation input
      { componentType: 5126, count: 2, type: 'VEC4' }, // animation output
    ],
  };
  const result = validateDocument(doc);
  assert.equal(result.pass, true, `expected PASS, got errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.skins, 1);
  assert.equal(result.animations, 1);
  assert.equal(result.triangles, 1);
  assert.deepEqual(result.errors, []);
});

test('manager repro end-to-end via validateFile / the CLI path on a real synthetic GLB', () => {
  const bin = Buffer.concat([
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer), // POSITION
    Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer), // NORMAL
    Buffer.from(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer), // inverseBindMatrices
    Buffer.from(new Float32Array([0, 1]).buffer), // animation input
    Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]).buffer), // animation output
  ]);
  const bv = (o, l) => ({ buffer: 0, byteOffset: o, byteLength: l });
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'joint' }, { mesh: 0 }, { mesh: 1 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { NORMAL: 1 } }] },
    ],
    skins: [{ joints: [0], inverseBindMatrices: 2 }],
    animations: [
      { samplers: [{ input: 3, output: 4 }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 1, type: 'MAT4' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [bv(0, 36), bv(36, 36), bv(72, 64), bv(136, 8), bv(144, 32)],
    buffers: [{ byteLength: 176 }],
  };
  const jsonBuffer = Buffer.from(JSON.stringify(doc), 'utf8');
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(data.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, data]);
  };
  const body = Buffer.concat([chunk('JSON', paddedJson), chunk('BIN\0', bin)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  const buffer = Buffer.concat([header, body]);

  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, true, `expected PASS, got errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.triangles, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('primitiveTriangleCount: no attributes.POSITION and no indices contributes 0, not a throw', () => {
  const accessors = [{ count: 3, type: 'VEC3', componentType: 5126 }];
  assert.equal(primitiveTriangleCount({ attributes: { NORMAL: 0 } }, accessors), 0);
  assert.equal(primitiveTriangleCount({ attributes: {} }, accessors), 0);
});

test('a POSITION-less primitive with 90,000 in-bounds indices is counted as 0 triangles, not 30,000 (updates the pre-round-4 assumption that `indices` alone makes a primitive countable)', () => {
  // Before round 4, `primitiveTriangleCount` counted `indices` whenever
  // present, regardless of POSITION, so this would have reported 30000
  // triangles (90000 / 3) and likely FAILed the 10,000 limit. Under decision
  // A2 a POSITION-less primitive renders nothing, so this must count as 0.
  const doc = baseDoc(); // mesh 0: 100 triangles, well within the limit
  doc.meshes.push({
    primitives: [{ attributes: {}, indices: 2, mode: 4 }], // no POSITION at all
  });
  doc.accessors.push({ count: 90000, type: 'SCALAR', componentType: 5125 }); // in-bounds indices accessor
  // Mesh 1 is referenced by no node, so it is still counted once (per the
  // "unreferenced mesh" rule) — at 0 triangles, not 30000.
  const result = validateDocument(doc);
  assert.equal(result.pass, true, `expected PASS, got errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.triangles, 100, 'the POSITION-less primitive must contribute 0, not 30000');
});

test('a POSITION-less primitive with out-of-range `indices` still fails shape validation', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0] = { attributes: {}, indices: 99, mode: 4 }; // no POSITION, no accessor 99
  const shapeErrors = validateShape(doc);
  assert.ok(
    shapeErrors.some((e) => e.includes('primitives[0].indices') && e.includes('accessors')),
    `expected an out-of-range indices shape error, got: ${JSON.stringify(shapeErrors)}`
  );
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('a POSITION-less primitive with `mode: 7` still fails (invalid mode, independent of POSITION)', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0] = { attributes: {}, mode: 7 }; // no POSITION, invalid mode
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.ok(
    result.errors.some((e) => e.includes('could not compute triangle count')),
    `expected a triangle-count error, got: ${JSON.stringify(result.errors)}`
  );
});

test('a primitive WITH POSITION is still counted exactly as before (no regression)', () => {
  // Unchanged control case: baseDoc()'s primitive has both POSITION and
  // indices, and must still use the indices accessor's count as before.
  const result = validateDocument(baseDoc());
  assert.equal(result.triangles, 100);
  assert.equal(result.pass, true);
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
  // Round 3: this is now caught by the shape gate (validateShape), before
  // triangle counting is ever attempted, rather than surfacing as a
  // "could not compute triangle count" error from countRenderedTriangles.
  assert.ok(
    result.errors.some((e) => e.includes('primitives[0].indices') && e.includes('accessors')),
    `expected an out-of-range indices shape error, got: ${JSON.stringify(result.errors)}`
  );
});

test('out-of-range node.mesh index fails instead of throwing uncaught', () => {
  const doc = baseDoc();
  doc.nodes = [{ mesh: 99 }];
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  // Round 3: caught by the shape gate before triangle counting.
  assert.ok(
    result.errors.some((e) => e.includes('nodes[0].mesh') && e.includes('meshes')),
    `expected an out-of-range node.mesh shape error, got: ${JSON.stringify(result.errors)}`
  );
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

// ---------------------------------------------------------------------------
// Round 3 CRUCIAL: whole-document shape validation (validateShape), closing
// the triangle-gate bypass through a non-array `meshes` and the reviewer's
// advisories in the same class (nodes-as-string, animations:[null],
// primitives:[], missing attributes).
// ---------------------------------------------------------------------------

test('validateShape returns no errors for the well-formed base document', () => {
  assert.deepEqual(validateShape(baseDoc()), []);
});

test('round-3 CRUCIAL repro: a non-array object `meshes` no longer bypasses the triangle gate', () => {
  // Exact shape from the manager's repro: an object-keyed `meshes` (not an
  // array), referenced by no node, whose one mesh has 90000/3 = 30000
  // triangles — today (pre-fix) countRenderedTriangles's `meshes.length` is
  // `undefined`, the "unreferenced mesh" loop never runs, and this reports
  // 0 triangles / PASS. It must now FAIL, before triangle counting even
  // starts.
  const doc = {
    asset: { version: '2.0' },
    skins: [{ joints: [0] }],
    animations: [{ channels: [], samplers: [] }],
    nodes: [{}],
    accessors: [{ count: 90000 }],
    meshes: { '0': { primitives: [{ attributes: { POSITION: 0 } }] } },
  };
  const result = validateDocument(doc);
  assert.equal(result.pass, false, `expected FAIL, got: ${JSON.stringify(result)}`);
  assert.equal(result.triangles, 0, 'shape gate must reject before any triangle counting is attempted');
  assert.ok(
    result.errors.some((e) => e.includes('`meshes`') && e.includes('array')),
    `expected a \`meshes\` shape error, got: ${JSON.stringify(result.errors)}`
  );
});

test('round-3 CRUCIAL repro end-to-end via validateFile / the CLI path on a real synthetic GLB', () => {
  const doc = {
    asset: { version: '2.0' },
    skins: [{ joints: [0] }],
    animations: [{ channels: [], samplers: [] }],
    nodes: [{}],
    accessors: [{ count: 90000 }],
    meshes: { '0': { primitives: [{ attributes: { POSITION: 0 } }] } },
  };
  const { dir, file } = tmpFile(buildGLB(doc));
  try {
    const result = validateFile(file);
    assert.equal(result.pass, false, `expected FAIL, got: ${JSON.stringify(result)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SHAPE_ARRAY_KEYS = ['nodes', 'meshes', 'accessors', 'skins', 'animations'];

for (const key of SHAPE_ARRAY_KEYS) {
  for (const [label, badValue] of [
    ['an object', { '0': {} }],
    ['a string', 'not-an-array'],
  ]) {
    test(`\`${key}\` as ${label} fails shape validation instead of bypassing the gate`, () => {
      const doc = baseDoc();
      doc[key] = badValue;
      const shapeErrors = validateShape(doc);
      assert.ok(
        shapeErrors.some((e) => e.includes(`\`${key}\``) && e.includes('array')),
        `expected a shape error naming \`${key}\`, got: ${JSON.stringify(shapeErrors)}`
      );
      const result = validateDocument(doc);
      assert.equal(result.pass, false, `expected FAIL for ${key} = ${JSON.stringify(badValue)}`);
      assert.deepEqual(result.errors, shapeErrors, 'validateDocument must surface the shape errors directly');
    });
  }
}

// ---------------------------------------------------------------------------
// Round 4 cosmetic fix: a shape-validation FAIL must report the real
// skins/animations counts when those fields ARE arrays (even though some
// *other* field failed shape validation), and 'n/a' when they are not
// arrays at all, instead of always printing 0/0.
// ---------------------------------------------------------------------------

test('a shape FAIL caused by a bad `meshes` still reports the real skins/animations counts', () => {
  const doc = baseDoc();
  doc.skins = [{ joints: [0] }, { joints: [1] }]; // 2 real skins
  doc.animations = [{ channels: [], samplers: [] }]; // 1 real animation
  doc.meshes = 'not-an-array'; // triggers the shape FAIL
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.skins, 2, 'skins is a real array, so its real length must be reported, not 0');
  assert.equal(result.animations, 1, 'animations is a real array, so its real length must be reported, not 0');
});

test('a shape FAIL where `skins`/`animations` themselves are not arrays reports "n/a", not a wrong number', () => {
  const doc = baseDoc();
  doc.skins = 'nope'; // not an array: no real count to report
  doc.animations = 42; // not an array: no real count to report
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
  assert.equal(result.skins, 'n/a');
  assert.equal(result.animations, 'n/a');
});

test('`animations: [null]` fails shape validation (each entry must be an object)', () => {
  const doc = baseDoc();
  doc.animations = [null];
  const shapeErrors = validateShape(doc);
  assert.ok(
    shapeErrors.some((e) => e.includes('animations[0]')),
    `expected an animations[0] shape error, got: ${JSON.stringify(shapeErrors)}`
  );
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('an empty `primitives` array fails shape validation (the schema requires >= 1)', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives = [];
  const shapeErrors = validateShape(doc);
  assert.ok(
    shapeErrors.some((e) => e.includes('meshes[0].primitives')),
    `expected a meshes[0].primitives shape error, got: ${JSON.stringify(shapeErrors)}`
  );
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('a primitive with `attributes` missing entirely fails shape validation', () => {
  const doc = baseDoc();
  delete doc.meshes[0].primitives[0].attributes;
  const shapeErrors = validateShape(doc);
  assert.ok(
    shapeErrors.some((e) => e.includes('attributes')),
    `expected an attributes shape error, got: ${JSON.stringify(shapeErrors)}`
  );
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('a primitive whose `attributes` is a non-object (e.g. a string) fails shape validation', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].attributes = 'nope';
  const shapeErrors = validateShape(doc);
  assert.ok(shapeErrors.some((e) => e.includes('attributes')));
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('an out-of-range `attributes.POSITION` index fails shape validation', () => {
  const doc = baseDoc();
  doc.meshes[0].primitives[0].attributes.POSITION = 99;
  const shapeErrors = validateShape(doc);
  assert.ok(shapeErrors.some((e) => e.includes('attributes.POSITION')));
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

test('a skin `joints` entry that is not a non-negative integer fails shape validation', () => {
  const doc = baseDoc();
  doc.skins = [{ joints: [0, -1, 'x'] }];
  const shapeErrors = validateShape(doc);
  assert.ok(shapeErrors.some((e) => e.includes('joints[1]')));
  assert.ok(shapeErrors.some((e) => e.includes('joints[2]')));
  const result = validateDocument(doc);
  assert.equal(result.pass, false);
});

// ---------------------------------------------------------------------------
// Round 3: full multi-chunk GLB container walking (not just the JSON chunk).
// ---------------------------------------------------------------------------

test('rejects a BIN chunk whose declared length wildly overflows the file (advisory d)', () => {
  const doc = baseDoc();
  const buffer = buildGLBRaw({
    chunks: [
      { type: 'JSON', data: jsonChunkData(doc) },
      // Claims 1 MiB of BIN payload but only 16 real bytes actually follow.
      { type: 'BIN\0', data: Buffer.alloc(16, 0), lengthOverride: 1024 * 1024 },
    ],
  });
  assert.throws(() => parseGLB(buffer), /malformed|truncated/i);

  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a BIN chunk whose declared length undershoots the actual remaining bytes (untiled leftover)', () => {
  const doc = baseDoc();
  const binData = Buffer.alloc(100, 0); // 100 real bytes actually present
  const buffer = buildGLBRaw({
    chunks: [
      { type: 'JSON', data: jsonChunkData(doc) },
      // Declares only 96 bytes, but 100 real bytes follow -> 4 leftover
      // bytes that don't tile to the declared total length.
      { type: 'BIN\0', data: binData, lengthOverride: 96 },
    ],
  });
  assert.throws(() => parseGLB(buffer), /malformed|truncated/i);

  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a BIN chunk whose declared length is not a multiple of 4', () => {
  const doc = baseDoc();
  const buffer = buildGLBRaw({
    chunks: [
      { type: 'JSON', data: jsonChunkData(doc) },
      { type: 'BIN\0', data: Buffer.alloc(10, 0) }, // 10 is not a multiple of 4
    ],
  });
  assert.throws(() => parseGLB(buffer), /multiple of 4/);
});

for (const garbageLength of [4, 8]) {
  test(`rejects ${garbageLength} bytes of trailing garbage after the last chunk (advisory d)`, () => {
    const doc = baseDoc();
    // Non-zero, non-chunk-shaped bytes: as a little-endian chunk length this
    // decodes to a huge, clearly out-of-bounds value, so it can't
    // accidentally happen to parse as a valid trailing chunk.
    const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]).subarray(0, garbageLength);
    const buffer = buildGLBRaw({
      chunks: [{ type: 'JSON', data: jsonChunkData(doc) }],
      extraTrailingBytes: garbage,
    });
    assert.throws(() => parseGLB(buffer), /malformed|truncated/i);

    const { dir, file } = tmpFile(buffer);
    try {
      const result = validateFile(file);
      assert.equal(result.pass, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Round 3: valid multi-chunk / formatting variations that must still PASS.
// ---------------------------------------------------------------------------

test('valid: a JSON chunk followed by a zero-padded BIN chunk still passes', () => {
  const doc = baseDoc();
  const buffer = buildGLBRaw({
    chunks: [
      { type: 'JSON', data: jsonChunkData(doc) },
      { type: 'BIN\0', data: Buffer.alloc(16, 0) }, // already a multiple of 4
    ],
  });
  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, true, `expected PASS, got errors: ${JSON.stringify(result.errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid: pretty-printed JSON with trailing spaces still passes', () => {
  const doc = baseDoc();
  const prettyJson = `${JSON.stringify(doc, null, 2)}   `; // extra literal trailing spaces
  const buffer = buildGLBFromRawJSONText(prettyJson);
  const { dir, file } = tmpFile(buffer);
  try {
    const result = validateFile(file);
    assert.equal(result.pass, true, `expected PASS, got errors: ${JSON.stringify(result.errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid: the three real mascot assets still pass after the round-3 shape + container hardening', () => {
  for (const name of ['crab.glb', 'gull.glb', 'buoy.glb']) {
    const assetPath = path.join(REPO_ROOT, 'assets', 'mascots', name);
    if (!existsSync(assetPath)) {
      continue;
    }
    const result = validateFile(assetPath);
    assert.equal(result.pass, true, `expected ${name} to PASS, got errors: ${JSON.stringify(result.errors)}`);
  }
});
