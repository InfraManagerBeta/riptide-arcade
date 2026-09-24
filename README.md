# Riptide Arcade

Small static browser games, built as tasks on a Riptide network: each game is one posted
task referencing a spec in `specs/`; agent workers deliver rival pull requests; the poster
reviews by running the verifiers, reading the playtest report, and **playing the preview** —
and pays by merging.

Everything here runs statically. Games are single self-contained HTML files built from
`templates/base-game.html`; tooling (verifiers, playtest harness, regression suite) runs at
development and review time only.

The substrate — template, verifiers, playtest harness, regression suite, and the game-task
spec template — is itself the first task: [`specs/001-init-scaffold.md`](specs/001-init-scaffold.md).
Until it merges, this repository is just that spec.

## Mascot generation pipeline

The three mascots in [`assets/mascots/`](assets/mascots/) — `crab.glb`, `gull.glb`,
`buoy.glb` — were generated with [Tripo3D](https://www.tripo3d.ai/)'s API
(`https://api.tripo3d.ai/v2/openapi`), per [`specs/002-mascot-pack.md`](specs/002-mascot-pack.md).
None of the meshes are hand-modeled or sourced from an asset library.

### Tool and pipeline

Each mascot went through the same four-stage Tripo task chain:

1. **Generate** — `text_to_model` from a text prompt describing the character in a
   full-body T-pose, with `pbr: true`, `texture: true`, and a `face_limit` of 8500
   (a safety margin under the spec's 10,000-triangle cap, since rigging/export never
   removes geometry but the exported mesh can render a little above the face count
   Tripo used internally). Model version `v3.1-20260211`.
2. **Rig check** — `animate_prerigcheck` on the generated model, to see whether Tripo
   thinks it's riggable and what body plan it detects.
3. **Rig** — `animate_rig` with `rig_type: biped`, `model_version: v1.0-20240301`
   (Tripo's anatomical/Mixamo-like biped skeleton — the auto-detected creature rig
   path on this API version does not reliably rig humanoid-posed meshes), `spec: tripo`,
   `out_format: glb`. Every mascot was posed and rigged as a two-legged, two-armed
   biped (claws/wings standing in for arms), which the task brief explicitly allows.
4. **Retarget** — `animate_retarget` on the rig task, requesting `preset:biped:idle`
   with `out_format: glb`. Tripo names the resulting glTF animation clip `idle`
   automatically.

Each stage's task ID, parameters, and credit cost are recorded in that mascot's
provenance sidecar: [`crab.provenance.json`](assets/mascots/crab.provenance.json),
[`gull.provenance.json`](assets/mascots/gull.provenance.json),
[`buoy.provenance.json`](assets/mascots/buoy.provenance.json). The exact prompt used
for each mascot is also in its sidecar under `prompt`.

All three exports came back with a single skin (41 joints), the mesh bound via
`JOINTS_0`/`WEIGHTS_0` with the node's `skin` set, one `idle` animation clip that
loops cleanly (first and last sampled pose match to within ~0.002 model units), one
PBR material (`pbrMetallicRoughness` with `baseColorTexture`, `metallicRoughnessTexture`,
and `normalTexture`, all 2048×2048), and a rendered triangle count comfortably under
the 10,000 cap (see each sidecar's `mesh.rendered_triangles`).

### Re-generating an asset

Re-running the pipeline needs a Tripo API key in the `TRIPO_API_KEY` environment
variable (never hard-code or commit the key itself — refer to it only by this
variable name). With that set, repeat the four calls above against
`https://api.tripo3d.ai/v2/openapi/task` (submit) and
`https://api.tripo3d.ai/v2/openapi/task/{task_id}` (poll), using the `prompt` and
`generation_parameters` from the relevant provenance sidecar for step 1, then chain
steps 2–4 the same way, substituting the new task IDs as you go. Download the final
`animate_retarget` task's `result.model.url` (the link expires shortly after the task
completes) and save it as the corresponding `assets/mascots/<name>.glb`, then update
that mascot's provenance sidecar with the new task IDs, prompt (if changed), and
credit costs.

## Validating mascots

Spec [`specs/002-mascot-pack.md`](specs/002-mascot-pack.md) requires three
rigged, game-ready GLB mascots (`assets/mascots/crab.glb`, `gull.glb`,
`buoy.glb`). `scripts/validate-mascots.mjs` is a zero-dependency (Node 20+
built-ins only, no npm packages) validator that parses each GLB and fails it
unless:

- it has **≥ 1 skin** (`skins.length >= 1`),
- it has **≥ 1 animation** (`animations.length >= 1`), and
- it has **≤ 10,000 rendered triangles**.

**Rendered triangles** are computed as follows:

- For every node in the document (in *any* node list, whether or not that
  node is reachable from a scene) that references a mesh, the mesh's
  primitives are summed and added to the total.
- A mesh instanced by *N* nodes is counted *N* times; a mesh referenced by
  no node at all is still counted once.
- Per primitive: mode `4` (`TRIANGLES`, the default when `mode` is absent)
  contributes `floor(count / 3)`; mode `5` (`TRIANGLE_STRIP`) and mode `6`
  (`TRIANGLE_FAN`) contribute `max(count - 2, 0)`; point/line modes (`0`–`3`)
  contribute `0`. `count` is the `indices` accessor's `count` when
  `indices` is present on the primitive, otherwise the `POSITION`
  accessor's `count`.

The validator also fails a file that is missing, unreadable, or malformed
(bad GLB magic, wrong version, truncated, or a first chunk that isn't the
JSON chunk) — it does not add any extra gates (e.g. no PBR checks) beyond
the spec's three conditions.

### Running it locally

```sh
# validate the three default mascot assets (assets/mascots/{crab,gull,buoy}.glb)
node scripts/validate-mascots.mjs

# or validate specific file(s) instead
node scripts/validate-mascots.mjs path/to/one.glb path/to/two.glb
```

Exit code is `0` only if every checked file passes; otherwise it's `1`. Each
file prints one line (skins/animations/triangles and PASS or FAIL with
reasons), followed by a summary line.

Run the validator's own test suite (synthetic, in-memory/tmp-dir GLBs — no
real assets required) with:

```sh
node --test scripts/validate-mascots.test.mjs
```

### CI

[`.github/workflows/validate-mascots.yml`](.github/workflows/validate-mascots.yml)
runs on every push and pull request, on a Node 20 and Node 22 matrix: it runs
`node --test scripts/validate-mascots.test.mjs` and then
`node scripts/validate-mascots.mjs` against the real assets. It is a
standalone workflow independent of spec 001's substrate. Green means all
three mascot assets pass.
