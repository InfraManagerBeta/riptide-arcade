#!/usr/bin/env node
// scripts/validate-mascots.mjs
//
// Zero-dependency GLB validator for the mascot pack (spec 002).
//
// For each target file this parses the GLB container, reads the glTF JSON
// chunk (the BIN chunk is not needed for these checks), and fails the file
// unless:
//   - skins.length >= 1
//   - animations.length >= 1
//   - rendered triangles <= 10,000
//
// "Rendered triangles" (decision A2):
//   - For every node (in ANY node list, whether or not it is reachable from
//     a scene) that references a mesh, sum triangles over that mesh's
//     primitives and add that sum to the total.
//   - A mesh instanced by N nodes is counted N times. A mesh referenced by
//     no node at all is still counted once.
//   - Per primitive: mode 4 (TRIANGLES, the default when `mode` is absent)
//     contributes floor(count / 3); mode 5 (TRIANGLE_STRIP) and mode 6
//     (TRIANGLE_FAN) contribute max(count - 2, 0); modes 0-3 (points/lines)
//     contribute 0. `count` is the `indices` accessor's `count` when
//     `indices` is present, otherwise the POSITION accessor's `count`.
//
// Node 20+ built-ins only. No npm dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GLTF_MAGIC = 'glTF';
const GLTF_VERSION = 2;
const JSON_CHUNK_TYPE = 'JSON';

const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

const TRIANGLE_LIMIT = 10000;

const DEFAULT_ASSET_NAMES = ['crab.glb', 'gull.glb', 'buoy.glb'];

/**
 * Parse a GLB container buffer and return the parsed glTF JSON object.
 * Throws a descriptive Error for bad magic, wrong version, truncation, or a
 * first chunk that isn't JSON.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {object} the parsed glTF JSON
 */
export function parseGLB(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  if (buffer.length < 12) {
    throw new Error(
      `truncated GLB: file is ${buffer.length} bytes, need at least 12 for the header`
    );
  }

  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== GLTF_MAGIC) {
    throw new Error(`bad magic: expected "${GLTF_MAGIC}", got ${JSON.stringify(magic)}`);
  }

  const version = buffer.readUInt32LE(4);
  if (version !== GLTF_VERSION) {
    throw new Error(`unsupported version: expected ${GLTF_VERSION}, got ${version}`);
  }

  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength > buffer.length) {
    throw new Error(
      `truncated GLB: header declares total length ${declaredLength} but file is only ${buffer.length} bytes`
    );
  }

  if (buffer.length < 20) {
    throw new Error(
      `truncated GLB: missing first chunk header (need at least 20 bytes, have ${buffer.length})`
    );
  }

  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.toString('ascii', 16, 20);
  if (chunkType !== JSON_CHUNK_TYPE) {
    throw new Error(`first chunk is not JSON: got chunk type ${JSON.stringify(chunkType)}`);
  }

  const chunkStart = 20;
  const chunkEnd = chunkStart + chunkLength;
  if (chunkEnd > buffer.length) {
    throw new Error(
      `truncated GLB: JSON chunk declares length ${chunkLength} but only ${
        buffer.length - chunkStart
      } bytes remain`
    );
  }

  const jsonText = buffer.toString('utf8', chunkStart, chunkEnd);
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`malformed JSON chunk: ${err.message}`);
  }
}

/**
 * Triangle contribution of a single primitive, per decision A2.
 *
 * @param {object} primitive
 * @param {object[]} accessors
 * @returns {number}
 */
export function primitiveTriangleCount(primitive, accessors) {
  const mode = primitive.mode === undefined ? MODE_TRIANGLES : primitive.mode;

  if (mode < MODE_TRIANGLES) {
    // 0 POINTS, 1 LINES, 2 LINE_LOOP, 3 LINE_STRIP
    return 0;
  }

  let count;
  if (primitive.indices !== undefined) {
    const accessor = accessors[primitive.indices];
    if (!accessor) {
      throw new Error(`primitive references missing indices accessor ${primitive.indices}`);
    }
    count = accessor.count;
  } else {
    const posIndex = primitive.attributes && primitive.attributes.POSITION;
    if (posIndex === undefined) {
      throw new Error('primitive has no indices and no POSITION attribute');
    }
    const accessor = accessors[posIndex];
    if (!accessor) {
      throw new Error(`primitive references missing POSITION accessor ${posIndex}`);
    }
    count = accessor.count;
  }

  if (mode === MODE_TRIANGLES) {
    return Math.floor(count / 3);
  }
  if (mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN) {
    return Math.max(count - 2, 0);
  }
  // No other modes are defined by glTF 2.0 (0-6). Treat anything else as 0.
  return 0;
}

/**
 * Rendered triangle count for a whole glTF document, per decision A2:
 * every node (in any node list) that references a mesh adds that mesh's
 * triangle count; a mesh referenced by no node still counts once; a mesh
 * instanced by N nodes counts N times.
 *
 * @param {object} json parsed glTF document
 * @returns {number}
 */
export function countRenderedTriangles(json) {
  const meshes = json.meshes || [];
  const accessors = json.accessors || [];
  const nodes = json.nodes || [];

  const meshTriangleCache = new Map();
  function meshTriangles(meshIndex) {
    if (meshTriangleCache.has(meshIndex)) {
      return meshTriangleCache.get(meshIndex);
    }
    const mesh = meshes[meshIndex];
    if (!mesh) {
      throw new Error(`node references missing mesh index ${meshIndex}`);
    }
    let total = 0;
    for (const primitive of mesh.primitives || []) {
      total += primitiveTriangleCount(primitive, accessors);
    }
    meshTriangleCache.set(meshIndex, total);
    return total;
  }

  let total = 0;
  const referenced = new Set();

  for (const node of nodes) {
    if (node && node.mesh !== undefined) {
      referenced.add(node.mesh);
      total += meshTriangles(node.mesh);
    }
  }

  for (let i = 0; i < meshes.length; i++) {
    if (!referenced.has(i)) {
      total += meshTriangles(i);
    }
  }

  return total;
}

/**
 * Validate an already-parsed glTF document against the spec 002 gates:
 * skins.length >= 1, animations.length >= 1, rendered triangles <= 10000.
 * Does NOT add any extra gates (e.g. no PBR checks).
 *
 * @param {object} json
 * @returns {{skins:number, animations:number, triangles:number, pass:boolean, errors:string[]}}
 */
export function validateDocument(json) {
  const skins = Array.isArray(json.skins) ? json.skins.length : 0;
  const animations = Array.isArray(json.animations) ? json.animations.length : 0;

  const errors = [];
  let triangles = 0;
  try {
    triangles = countRenderedTriangles(json);
  } catch (err) {
    errors.push(`could not compute triangle count: ${err.message}`);
  }

  if (skins < 1) {
    errors.push(`${skins} skins (need >= 1)`);
  }
  if (animations < 1) {
    errors.push(`${animations} animations (need >= 1)`);
  }
  if (!errors.some((e) => e.startsWith('could not compute triangle count')) && triangles > TRIANGLE_LIMIT) {
    errors.push(`${triangles} rendered triangles (need <= ${TRIANGLE_LIMIT})`);
  }

  return { skins, animations, triangles, pass: errors.length === 0, errors };
}

/**
 * Read and validate one GLB file from disk. Missing / unreadable / malformed
 * files are reported as a failure, never thrown.
 *
 * @param {string} filePath
 * @returns {{file:string, skins:number, animations:number, triangles:number, pass:boolean, errors:string[]}}
 */
export function validateFile(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'missing file' : `cannot read file: ${err.message}`;
    return { file: filePath, skins: 0, animations: 0, triangles: 0, pass: false, errors: [reason] };
  }

  let json;
  try {
    json = parseGLB(buffer);
  } catch (err) {
    return {
      file: filePath,
      skins: 0,
      animations: 0,
      triangles: 0,
      pass: false,
      errors: [`GLB parse error: ${err.message}`],
    };
  }

  const result = validateDocument(json);
  return { file: filePath, ...result };
}

/**
 * Resolve the default three mascot asset paths, relative to the repo root
 * (i.e. relative to this script's location), never relative to cwd.
 *
 * @returns {string[]}
 */
export function resolveDefaultPaths() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  return DEFAULT_ASSET_NAMES.map((name) => path.join(repoRoot, 'assets', 'mascots', name));
}

/**
 * Run the CLI: validate the given paths (or the three default mascot paths
 * when none are given), print one line per file plus a summary.
 *
 * @param {string[]} argv paths from process.argv.slice(2)
 * @returns {number} process exit code: 0 iff every file passed
 */
export function runCLI(argv) {
  const files = argv.length > 0 ? argv : resolveDefaultPaths();
  const results = files.map(validateFile);

  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    const reasons = r.errors.length ? ` — ${r.errors.join('; ')}` : '';
    console.log(
      `${status} ${r.file}: skins=${r.skins} animations=${r.animations} triangles=${r.triangles}${reasons}`
    );
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} passed`);

  return passCount === results.length ? 0 : 1;
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const exitCode = runCLI(process.argv.slice(2));
  process.exit(exitCode);
}
