#!/usr/bin/env node
// scripts/validate-mascots.mjs
//
// Zero-dependency GLB validator for the mascot pack (spec 002).
//
// For each target file this walks the GLB container (every chunk, not just
// the JSON chunk), reads the glTF JSON chunk, runs a whole-document shape
// validation pass, and fails the file unless:
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
//   - A primitive with no `POSITION` attribute contributes 0 triangles,
//     whether or not it has `indices`: the glTF 2.0 schema does not require
//     `POSITION`, and clients skip rendering such a primitive (round 4).
//
// Shape validation (round 3, closing a triangle-gate bypass through a
// non-array `meshes`): before any counting happens, `validateShape()` walks
// the whole parsed document once and fails the file if `nodes`, `meshes`,
// `accessors`, `skins`, or `animations`, when present, are anything other
// than an Array of plain (non-null, non-array) objects, if any mesh's
// `primitives` is not a non-empty Array of plain objects with a plain-object
// `attributes`, if any skin's `joints` is not a non-empty Array of
// non-negative integers, or if `node.mesh` / `primitive.indices` /
// `attributes.POSITION` is present but not an in-bounds integer index. This
// is the single shape gate all counting code depends on; the counting code
// itself no longer trusts raw `json.*` fields.
//
// Node 20+ built-ins only. No npm dependencies.

import { readFileSync, realpathSync } from 'node:fs';
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
 * Walks EVERY chunk after the 12-byte header (not just the JSON chunk):
 * each chunk needs a complete 8-byte header, its length must fit within the
 * declared total length, and its length must be a multiple of 4. The chunks
 * must exactly tile the declared length, with no gaps and no trailing bytes.
 * The first chunk must be JSON, and the header's declared total length must
 * equal the actual file size.
 * Throws a descriptive Error for bad magic, wrong version, truncation, a
 * first chunk that isn't JSON, or any chunk-tiling violation.
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
  if (declaredLength !== buffer.length) {
    throw new Error(
      `malformed GLB: header declares total length ${declaredLength} but file is ${buffer.length} bytes (extra trailing data)`
    );
  }

  // Walk every chunk in [12, declaredLength). Chunks must exactly tile that
  // range: no chunk may claim to extend past declaredLength, no chunk length
  // may be anything other than a multiple of 4, and there must be no leftover
  // bytes once the last chunk ends (that would mean trailing garbage, or a
  // chunk whose declared length undershoots the bytes actually present).
  let offset = 12;
  let chunkIndex = 0;
  let jsonText = null;

  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) {
      throw new Error(
        `truncated GLB: incomplete chunk header at byte ${offset} (need 8 bytes, only ${
          declaredLength - offset
        } remain within the declared length)`
      );
    }

    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);

    if (chunkIndex === 0 && chunkType !== JSON_CHUNK_TYPE) {
      throw new Error(`first chunk is not JSON: got chunk type ${JSON.stringify(chunkType)}`);
    }

    if (chunkLength % 4 !== 0) {
      throw new Error(
        `malformed GLB: chunk ${chunkIndex} (type ${JSON.stringify(chunkType)}) length ${chunkLength} is not a multiple of 4`
      );
    }

    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > declaredLength) {
      throw new Error(
        `truncated GLB: chunk ${chunkIndex} (type ${JSON.stringify(chunkType)}) declares length ${chunkLength} but only ${
          declaredLength - chunkStart
        } bytes remain within the declared GLB length`
      );
    }

    if (chunkIndex === 0) {
      jsonText = buffer.toString('utf8', chunkStart, chunkEnd);
    }

    offset = chunkEnd;
    chunkIndex++;
  }

  if (jsonText === null) {
    throw new Error(
      `truncated GLB: missing first chunk header (no chunks found within the declared length)`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`malformed JSON chunk: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(`malformed JSON chunk: expected a JSON object at the top level, got ${kind}`);
  }

  return parsed;
}

/**
 * @param {*} value
 * @returns {boolean} true iff value is a plain, non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {*} value
 * @returns {boolean} true iff value is a non-negative integer.
 */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * @param {*} value
 * @returns {string} a short human-readable type description for error text:
 * "null", "array", or the JS `typeof` string.
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Whole-document shape validation (round 3): a single pass, run before any
 * counting, that fails the file (returns errors, never throws) on any
 * container/shape bypass in this class:
 *
 *   - `nodes`, `meshes`, `accessors`, `skins`, `animations`: each, when
 *     present, must be an Array whose every entry is a plain non-null
 *     object (not an array, not a string, not a bare number/boolean/null).
 *   - Each mesh's `primitives` must be a non-empty Array of plain objects.
 *     Each primitive's `attributes` must be a plain object.
 *   - Each skin's `joints` must be a non-empty Array of non-negative
 *     integers.
 *   - Each animation entry must be a plain object (nothing more is
 *     required of animations here).
 *   - `node.mesh`, `primitive.indices`, and `attributes.POSITION`: when
 *     present, must be an integer index within the bounds of the relevant
 *     array (an absent/malformed target array counts as zero-length, so any
 *     reference into it fails).
 *
 * This is the single shape gate the counting code depends on: absent is
 * fine (treated as empty), present-but-wrong-type is always a FAIL, never a
 * silently-ignored or coerced value.
 *
 * @param {object} json parsed glTF document
 * @returns {string[]} shape-violation error strings; empty when the
 *   document's shape is valid.
 */
export function validateShape(json) {
  const errors = [];

  /**
   * Validate that `json[key]`, when present, is an Array of plain objects.
   * Returns the array to use for further bounds checks: `[]` when the key is
   * absent (valid, empty), the real array when it's an array (even if some
   * entries are malformed — already reported), or `null` when the key is
   * present but not an array at all (already reported; callers should treat
   * `null` as "nothing valid to index into", i.e. length 0).
   *
   * @param {string} key
   * @returns {object[]|null}
   */
  function checkTopLevelArray(key) {
    const value = json[key];
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      errors.push(`\`${key}\` must be an array, got ${describeType(value)}`);
      return null;
    }
    value.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(`\`${key}[${i}]\` must be an object, got ${describeType(entry)}`);
      }
    });
    return value;
  }

  const nodes = checkTopLevelArray('nodes');
  const meshes = checkTopLevelArray('meshes');
  const accessors = checkTopLevelArray('accessors');
  const skins = checkTopLevelArray('skins');
  checkTopLevelArray('animations');

  const meshCount = meshes === null ? 0 : meshes.length;
  const accessorCount = accessors === null ? 0 : accessors.length;

  // meshes: primitives (non-empty array of plain objects) and each
  // primitive's attributes (plain object) / indices / attributes.POSITION
  // (in-bounds integer index into accessors, when present).
  if (meshes) {
    meshes.forEach((mesh, mi) => {
      if (!isPlainObject(mesh)) {
        return; // already reported by checkTopLevelArray
      }
      const primitives = mesh.primitives;
      if (!Array.isArray(primitives) || primitives.length === 0) {
        errors.push(
          `\`meshes[${mi}].primitives\` must be a non-empty array, got ${describeType(primitives)}`
        );
        return;
      }
      primitives.forEach((primitive, pi) => {
        if (!isPlainObject(primitive)) {
          errors.push(
            `\`meshes[${mi}].primitives[${pi}]\` must be an object, got ${describeType(primitive)}`
          );
          return;
        }
        if (!isPlainObject(primitive.attributes)) {
          errors.push(
            `\`meshes[${mi}].primitives[${pi}].attributes\` must be an object, got ${describeType(
              primitive.attributes
            )}`
          );
        } else if (primitive.attributes.POSITION !== undefined) {
          const pos = primitive.attributes.POSITION;
          if (!Number.isInteger(pos) || pos < 0 || pos >= accessorCount) {
            errors.push(
              `\`meshes[${mi}].primitives[${pi}].attributes.POSITION\` must be an integer index into accessors (0..${
                accessorCount - 1
              }), got ${JSON.stringify(pos)}`
            );
          }
        }
        if (primitive.indices !== undefined) {
          const idx = primitive.indices;
          if (!Number.isInteger(idx) || idx < 0 || idx >= accessorCount) {
            errors.push(
              `\`meshes[${mi}].primitives[${pi}].indices\` must be an integer index into accessors (0..${
                accessorCount - 1
              }), got ${JSON.stringify(idx)}`
            );
          }
        }
      });
    });
  }

  // skins: joints must be a non-empty array of non-negative integers.
  if (skins) {
    skins.forEach((skin, si) => {
      if (!isPlainObject(skin)) {
        return; // already reported by checkTopLevelArray
      }
      const joints = skin.joints;
      if (!Array.isArray(joints) || joints.length === 0) {
        errors.push(
          `\`skins[${si}].joints\` must be a non-empty array, got ${describeType(joints)}`
        );
        return;
      }
      joints.forEach((joint, ji) => {
        if (!isNonNegativeInteger(joint)) {
          errors.push(
            `\`skins[${si}].joints[${ji}]\` must be a non-negative integer, got ${JSON.stringify(joint)}`
          );
        }
      });
    });
  }

  // nodes: node.mesh, when present, must be an in-bounds integer index.
  if (nodes) {
    nodes.forEach((node, ni) => {
      if (!isPlainObject(node)) {
        return; // already reported by checkTopLevelArray
      }
      if (node.mesh !== undefined) {
        const meshIndex = node.mesh;
        if (!Number.isInteger(meshIndex) || meshIndex < 0 || meshIndex >= meshCount) {
          errors.push(
            `\`nodes[${ni}].mesh\` must be an integer index into meshes (0..${
              meshCount - 1
            }), got ${JSON.stringify(meshIndex)}`
          );
        }
      }
    });
  }

  return errors;
}

/**
 * Triangle contribution of a single primitive, per decision A2.
 *
 * The glTF 2.0 schema does not require a `POSITION` attribute on a
 * primitive (spec §3.7.2.1); when it is absent, clients SHOULD skip
 * rendering that primitive entirely. Under decision A2 ("rendered"
 * triangles) that means a POSITION-less primitive always contributes 0
 * triangles — whether or not it has `indices` — because there are no vertex
 * positions to render, indexed or not. This is a valid document, not an
 * error; bounds/shape validity of `indices` (when present) is still
 * enforced up front by `validateShape()`, and a malformed `mode` still
 * fails below regardless of whether `POSITION` is present.
 *
 * @param {object} primitive
 * @param {object[]} accessors
 * @returns {number}
 */
export function primitiveTriangleCount(primitive, accessors) {
  let mode = primitive.mode;
  if (mode === undefined) {
    mode = MODE_TRIANGLES;
  } else if (!Number.isInteger(mode) || mode < 0 || mode > 6) {
    // glTF 2.0 only defines modes 0-6. Anything else (including non-numeric
    // values like the string "4") is malformed, not silently ignorable.
    throw new Error(
      `primitive has invalid mode ${JSON.stringify(mode)} (must be an integer 0-6 when present)`
    );
  }

  if (mode < MODE_TRIANGLES) {
    // 0 POINTS, 1 LINES, 2 LINE_LOOP, 3 LINE_STRIP
    return 0;
  }

  const attributes = primitive.attributes;
  const hasPosition = attributes && attributes.POSITION !== undefined;
  if (!hasPosition) {
    // No POSITION -> nothing to render, regardless of `indices`. Not an
    // error (round 4 CRUCIAL fix).
    return 0;
  }

  let accessorIndex;
  let sourceLabel;
  if (primitive.indices !== undefined) {
    accessorIndex = primitive.indices;
    sourceLabel = 'indices';
  } else {
    accessorIndex = attributes.POSITION;
    sourceLabel = 'POSITION';
  }

  if (
    !Number.isInteger(accessorIndex) ||
    accessorIndex < 0 ||
    accessorIndex >= accessors.length
  ) {
    throw new Error(
      `primitive references out-of-range ${sourceLabel} accessor index ${JSON.stringify(accessorIndex)}`
    );
  }

  const accessor = accessors[accessorIndex];
  if (!accessor) {
    throw new Error(`primitive references missing ${sourceLabel} accessor ${accessorIndex}`);
  }

  const count = accessor.count;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `accessor ${accessorIndex} has invalid count ${JSON.stringify(count)} (must be a non-negative integer)`
    );
  }

  if (mode === MODE_TRIANGLES) {
    return Math.floor(count / 3);
  }
  // mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN (validated above)
  return Math.max(count - 2, 0);
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
  // Rely on validated arrays only: absent = empty (fine), present-but-wrong
  // type is not silently coerced to empty here either — `Array.isArray`
  // check, not `|| []`, since `{} || []` and `"str" || []` both evaluate to
  // the truthy left-hand side and would mask a non-array value (the round-3
  // CRUCIAL). In the normal CLI/validateDocument path this code only runs
  // after validateShape() has already failed the file on any such mismatch;
  // these checks are the second, defense-in-depth line for direct callers.
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];

  const meshTriangleCache = new Map();
  function meshTriangles(meshIndex) {
    if (meshTriangleCache.has(meshIndex)) {
      return meshTriangleCache.get(meshIndex);
    }
    const mesh = meshes[meshIndex];
    if (!mesh) {
      throw new Error(`node references missing mesh index ${meshIndex}`);
    }
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    let total = 0;
    for (const primitive of primitives) {
      total += primitiveTriangleCount(primitive, accessors);
    }
    meshTriangleCache.set(meshIndex, total);
    return total;
  }

  let total = 0;
  const referenced = new Set();

  for (const node of nodes) {
    if (node && node.mesh !== undefined) {
      const meshIndex = node.mesh;
      if (!Number.isInteger(meshIndex) || meshIndex < 0 || meshIndex >= meshes.length) {
        throw new Error(`node references out-of-range mesh index ${JSON.stringify(meshIndex)}`);
      }
      referenced.add(meshIndex);
      total += meshTriangles(meshIndex);
    }
  }

  for (let i = 0; i < meshes.length; i++) {
    if (!referenced.has(i)) {
      total += meshTriangles(i);
    }
  }

  if (!Number.isFinite(total) || !Number.isInteger(total)) {
    throw new Error(`computed rendered triangle total ${total} is not a finite integer`);
  }

  return total;
}

/**
 * Validate an already-parsed glTF document against the spec 002 gates:
 * skins.length >= 1, animations.length >= 1, rendered triangles <= 10000.
 * Does NOT add any extra gates (e.g. no PBR checks).
 *
 * Runs `validateShape()` FIRST, before any counting: a shape violation is
 * reported as a failure immediately and no triangle counting is attempted
 * (there is nothing safe to count from a document whose containers don't
 * have the shape the counting code assumes).
 *
 * On a shape-validation failure, `skins`/`animations` report the real
 * `.length` when `json.skins` / `json.animations` happen to be Arrays (even
 * though some other part of the document failed shape validation), or the
 * string `'n/a'` when that field itself isn't an Array (so there is no real
 * count to report). `triangles` is always 0 in this case: shape validation
 * failed before any triangle counting was attempted.
 *
 * @param {object} json
 * @returns {{skins:number|string, animations:number|string, triangles:number, pass:boolean, errors:string[]}}
 */
export function validateDocument(json) {
  const shapeErrors = validateShape(json);
  if (shapeErrors.length > 0) {
    const skins = Array.isArray(json.skins) ? json.skins.length : 'n/a';
    const animations = Array.isArray(json.animations) ? json.animations.length : 'n/a';
    return { skins, animations, triangles: 0, pass: false, errors: shapeErrors };
  }

  const skinsList = Array.isArray(json.skins) ? json.skins : [];
  const skins = skinsList.length;
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
  // Note: "each skin needs a non-empty joints array" is now enforced by
  // validateShape() above, before this point is ever reached with skins >= 1
  // but a malformed joints array.
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
 * @returns {{file:string, skins:number|string, animations:number|string, triangles:number, pass:boolean, errors:string[]}}
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

/**
 * Determine whether this module was invoked directly as the CLI entry
 * point, robust to the entry path being a symlink (e.g. invoked as
 * `node /some/symlink/validate-mascots.mjs`, where `import.meta.url` is
 * resolved to the real file but `process.argv[1]` is not). Both paths are
 * realpath'd before comparison so a symlinked invocation still counts as
 * running the CLI, instead of silently doing nothing and exiting 0.
 *
 * @returns {boolean}
 */
function isRunAsCLI() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const scriptPath = realpathSync(fileURLToPath(import.meta.url));
    const entryPath = realpathSync(path.resolve(process.argv[1]));
    return scriptPath === entryPath;
  } catch {
    return false;
  }
}

if (isRunAsCLI()) {
  const exitCode = runCLI(process.argv.slice(2));
  process.exit(exitCode);
}
