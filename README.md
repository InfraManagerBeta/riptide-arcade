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
node --test scripts/
```

### CI

[`.github/workflows/validate-mascots.yml`](.github/workflows/validate-mascots.yml)
runs on every push and pull request: it runs `node --test scripts/` and then
`node scripts/validate-mascots.mjs` against the real assets. It is a
standalone workflow independent of spec 001's substrate. Green means all
three mascot assets pass.
