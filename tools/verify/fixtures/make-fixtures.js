#!/usr/bin/env node
'use strict';
/* =============================================================================
 * tools/verify/fixtures/make-fixtures.js — generates every checked-in GLB
 * fixture (and its .meta.json sidecar) used by tools/verify/budget.selftest.js
 * to prove the dormant GLB/rig budget path in tools/verify/budget.js.
 *
 * WHERE THE BYTES COME FROM: every .glb here is built BY THIS SCRIPT, from
 * scratch, as valid (or deliberately invalid-in-one-specific-way) GLB binary:
 * a 12-byte header (magic "glTF", version 2, total length) followed by a
 * single JSON chunk (4-byte-aligned, type "JSON") describing a minimal
 * glTF document — one mesh, one primitive, indexed triangles. There is no
 * real vertex geometry anywhere: budget.js's parser (by design, per the
 * spec's "no rendering, no 3D library" constraint) reads ONLY the 12-byte
 * header and the JSON chunk's `accessors[].count` fields to compute triangle
 * counts, so a minimal JSON document is sufficient to exercise it exactly
 * the same way a real asset would. This keeps every fixture tiny (well under
 * the ~7 KB ceiling the order set) while still being a byte-for-byte valid
 * GLB container.
 *
 * Run it yourself to regenerate everything from scratch:
 *   node tools/verify/fixtures/make-fixtures.js
 *
 * CASES (see fixtures/README.md for the full table):
 *   valid-triangle   — 1 triangle, matching sidecar, clean rig  -> PASS
 *   over-triangles   — 600 triangles (selftest budget caps at 500) -> FAIL triangleBudget
 *   over-filesize    — tiny geometry + a padding BIN chunk pushing the file
 *                      past the selftest's tight maxFileBytes -> FAIL fileSize
 *   no-sidecar       — valid GLB, sidecar file simply absent -> FAIL sidecarPresent
 *   rig-failed       — valid GLB + sidecar with rigStatus "dirty" -> FAIL rigCheck
 *   lying-sidecar    — valid GLB (10 real triangles) whose sidecar declares
 *                      500 -> FAIL declaredTrianglesMatch
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const OUT_DIR = __dirname;

// ---------------------------------------------------------------------------
// Minimal GLB binary writer — header + one JSON chunk (no BIN chunk unless
// `padBytes` is given, used only by the over-filesize case to inflate size).
// ---------------------------------------------------------------------------
function buildGlb(json, padBytes) {
  const jsonStr = JSON.stringify(json);
  let jsonBuf = Buffer.from(jsonStr, 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad > 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // glTF pads JSON with spaces

  const chunks = [{ type: 'JSON', data: jsonBuf }];
  if (padBytes) {
    let binBuf = Buffer.alloc(padBytes, 0);
    const binPad = (4 - (binBuf.length % 4)) % 4;
    if (binPad > 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]); // BIN pads with zeros
    chunks.push({ type: 'BIN\0', data: binBuf });
  }

  let totalLength = 12;
  for (const c of chunks) totalLength += 8 + c.data.length;

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);            // version 2
  header.writeUInt32LE(totalLength, 8);

  const parts = [header];
  for (const c of chunks) {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(c.data.length, 0);
    chunkHeader.write(c.type.padEnd(4, '\0').slice(0, 4), 4, 'ascii');
    parts.push(chunkHeader, c.data);
  }
  return Buffer.concat(parts);
}

// A minimal glTF document with `triangleCount` triangles via one indexed
// TRIANGLES primitive. No buffers/bufferViews are referenced beyond the
// accessors' own `count` field — that field is the only thing budget.js's
// countTriangles() reads, so this is sufficient and deliberate.
function minimalGltfJson(triangleCount) {
  const indexCount = triangleCount * 3;
  return {
    asset: { version: '2.0', generator: 'riptide-arcade tools/verify/fixtures/make-fixtures.js' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        name: `fixture-${triangleCount}-tri`,
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1, mode: 4 /* TRIANGLES */ },
        ],
      },
    ],
    accessors: [
      { count: Math.max(3, indexCount), type: 'VEC3', componentType: 5126 /* FLOAT */ },
      { count: indexCount, type: 'SCALAR', componentType: 5123 /* UNSIGNED_SHORT */ },
    ],
  };
}

function writeFixture(name, glbBuffer, meta) {
  const glbPath = path.join(OUT_DIR, `${name}.glb`);
  fs.writeFileSync(glbPath, glbBuffer);
  if (meta !== null) {
    fs.writeFileSync(`${glbPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
  } else {
    // no-sidecar case: make sure no stale sidecar lingers from a prior run.
    const sidecarPath = `${glbPath}.meta.json`;
    if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
  }
  console.log(`  wrote ${path.relative(path.join(OUT_DIR, '..', '..', '..'), glbPath)} ` +
    `(${glbBuffer.length}B)${meta !== null ? ' + sidecar' : ' (no sidecar)'}`);
}

function provenance(prompt) {
  return {
    tool: 'make-fixtures.js (hand-authored minimal glTF, no generative tool)',
    prompt,
    model: 'n/a — procedurally generated, not model-generated',
  };
}

function main() {
  console.log('tools/verify/fixtures/make-fixtures.js: generating GLB fixtures...');

  // 1. valid-triangle.glb — 1 real triangle, sidecar matches exactly, clean rig.
  writeFixture(
    'valid-triangle',
    buildGlb(minimalGltfJson(1)),
    {
      provenance: provenance('single triangle, minimal valid GLB fixture (happy path)'),
      declaredTriangles: 1,
      rigStatus: 'clean',
    },
  );

  // 2. over-triangles.glb — 600 triangles; budget.selftest.js caps at 500.
  //    Sidecar's declared count MATCHES the parsed count exactly, so the
  //    only failing check is triangleBudget, not declaredTrianglesMatch.
  writeFixture(
    'over-triangles',
    buildGlb(minimalGltfJson(600)),
    {
      provenance: provenance('600-triangle fixture, deliberately over the self-test triangle budget'),
      declaredTriangles: 600,
      rigStatus: 'clean',
    },
  );

  // 3. over-filesize.glb — trivial geometry (1 triangle) but padded with an
  //    unused BIN chunk so the file itself blows the self-test's tight
  //    maxFileBytes, while staying well under the ~7KB fixture ceiling.
  writeFixture(
    'over-filesize',
    buildGlb(minimalGltfJson(1), 4600),
    {
      provenance: provenance('1-triangle fixture padded with a filler BIN chunk to exceed a byte budget'),
      declaredTriangles: 1,
      rigStatus: 'clean',
    },
  );

  // 4. no-sidecar.glb — otherwise-valid GLB, sidecar simply does not exist.
  writeFixture(
    'no-sidecar',
    buildGlb(minimalGltfJson(1)),
    null,
  );

  // 5. rig-failed.glb — valid GLB + sidecar, but rigStatus is not "clean".
  writeFixture(
    'rig-failed',
    buildGlb(minimalGltfJson(2)),
    {
      provenance: provenance('2-triangle fixture with a sidecar reporting a failed rig check'),
      declaredTriangles: 2,
      rigStatus: 'dirty', // anything other than "clean" (case-insensitive) must fail rigCheck
    },
  );

  // 6. lying-sidecar.glb — real triangle count is 10; sidecar claims 500,
  //    far outside the 2%-floored-at-1 tolerance -> declaredTrianglesMatch
  //    must fail while every other check on this asset passes.
  writeFixture(
    'lying-sidecar',
    buildGlb(minimalGltfJson(10)),
    {
      provenance: provenance('10-triangle fixture whose sidecar lies about the triangle count'),
      declaredTriangles: 500,
      rigStatus: 'clean',
    },
  );

  console.log('done.');
}

if (require.main === module) main();

module.exports = { buildGlb, minimalGltfJson };
