# tools/verify/fixtures/ — GLB fixtures for the dormant budget/rig path

No game in this repository ships any assets today, so the GLB triangle-budget and
rig-check logic in `tools/verify/budget.js` is **dormant** in every real `npm run verify`
run (it only activates when a game dir contains `assets/`). Per the spec's non-goals, that
dormant path is proven correct here instead: a tiny checked-in GLB fixture per behavior,
exercised directly against `budget.js`'s own validation function by
`tools/verify/budget.selftest.js` — no browser, no game dir, no network.

**This directory is not, and must never look like, a game directory.** It has no
`index.html`, so `tools/verify/index.js` / the game verifiers can never mistake it for
one, and it sits outside `games/` entirely.

## Where the bytes come from

Every `.glb` here is generated **by `make-fixtures.js`**, in this directory, from
scratch — regenerate them all at any time with:

```
node tools/verify/fixtures/make-fixtures.js
```

Each file is a byte-for-byte valid GLB container: a 12-byte header (`glTF`, version 2,
total length) followed by a single 4-byte-aligned JSON chunk holding a minimal glTF
document (one mesh, one indexed `TRIANGLES` primitive). There is no real vertex geometry
in any of them — `budget.js`'s parser only ever reads the 12-byte header and the JSON
chunk's `accessors[].count` fields to compute a triangle count (per the order: "no
rendering, no 3D library"), so a minimal JSON document exercises the exact same code path
a real asset would, at a few hundred bytes instead of megabytes. The one exception is
`over-filesize.glb`, which adds a padding `BIN` chunk of zero bytes purely to inflate file
size for that one check.

## The six cases

Validated against the self-test's own tight budgets (`SELFTEST_GLB_BUDGETS` in
`budget.selftest.js`: `maxTriangles: 500, maxFileBytes: 4096, requireRigCheck: true` —
deliberately tighter than `budget.js`'s shipped defaults so small fixtures can genuinely
trip real limits; see `budget.js`'s `DEFAULT_BUDGETS` for what real games get):

| File | Size | Real triangles | Sidecar declares | Rig status | Expected failing check |
|---|---|---|---|---|---|
| `valid-triangle.glb` | ~0.4 KB | 1 | 1 | `clean` | none — all checks PASS |
| `over-triangles.glb` | ~0.4 KB | 600 | 600 | `clean` | `triangleBudget` (600 > 500) |
| `over-filesize.glb` | ~4.9 KB | 1 | 1 | `clean` | `fileSize` (padded past 4096B) |
| `no-sidecar.glb` | ~0.4 KB | 1 | *(no sidecar file)* | *(n/a)* | `sidecarPresent` (+ everything that depends on the sidecar) |
| `rig-failed.glb` | ~0.4 KB | 2 | 2 | `dirty` | `rigCheck` (not `"clean"`) |
| `lying-sidecar.glb` | ~0.4 KB | 10 | 500 | `clean` | `declaredTrianglesMatch` (500 vs 10, tolerance ±10) |

`budget.selftest.js` asserts each case's specific expected failing check(s) — not merely
"it failed somehow" — so a fixture that fails for the wrong reason is itself a self-test
failure.

## Sidecar naming and shape

`<file>.glb` → `<file>.glb.meta.json`, matching the worked example in
`docs/spec-template.md` §4 (Assets):

```json
{
  "provenance": { "tool": "...", "prompt": "...", "model": "..." },
  "declaredTriangles": 1,
  "rigStatus": "clean"
}
```
