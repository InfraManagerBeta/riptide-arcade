// scripts/validate-mascots.test.mjs
//
// Tests for scripts/validate-mascots.mjs, run with `node --test scripts/`.
// Builds synthetic GLB buffers in memory / in a tmp dir — no real mascot
// assets are needed or used.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseGLB,
  countRenderedTriangles,
  validateDocument,
  validateFile,
} from './validate-mascots.mjs';

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
