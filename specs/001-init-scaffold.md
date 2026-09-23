# 001 — Game substrate: base template, verifiers, playtest harness

This repository is a factory for small static browser games. Games are built as tasks on a
Riptide network: each game is one task, rival pull requests deliver implementations, and the
poster reviews by playing. Before any game task can be posted, the repository needs the
substrate every game will be built on and judged by. That substrate is this task.

Everything delivered here must work statically — no server, no build step for the games
themselves, no external services at play time. Tooling (Node scripts, Playwright) runs at
development and review time only.

## Deliverables

### 1. `templates/base-game.html` — the opinionated game shell

A single, self-contained HTML file (inline JS/CSS, zero dependencies, no build step) that
every future game starts from. It is not a game; it is the structure that makes games
testable and keeps known bug classes out. Required structure:

- **Fixed-timestep game loop** (accumulator pattern: simulation ticks at a fixed dt,
  rendering interpolates; `requestAnimationFrame` driven).
- **A single state machine chokepoint**: all state transitions go through one `setState(next)`
  function with `onStateExit(prev)` / `onStateEnter(next)` hooks. States at minimum:
  `LOADING → MENU → PLAYING → PAUSED / GAME_OVER`. Direct assignment to the state variable
  anywhere else is a defect.
- **Audio lifecycle discipline**: WebAudio unlocked on first user gesture; a single
  `resetAudioState()` called from state transitions (not from scattered call sites); an
  `updateContinuousAudio()` hook called unconditionally every frame *before* any
  state-guarded early return, so continuous sounds can never leak across states.
- **Input mapping layer**: keyboard, pointer, and touch events normalized into named game
  actions (e.g. `left/right/primary/pause`) in one place; games read actions, never raw events.
- **Canvas + resize discipline**: devicePixelRatio-aware canvas sizing, `visibilitychange`
  auto-pause, and a `prefers-reduced-motion` check exposed as a flag games must respect.
- **The `window.__test` hook** — the load-bearing piece. When (and only when) the page is
  opened with `?test=1`, the template exposes:
  - `__test.state()` — current state name;
  - `__test.snapshot()` — JSON-serializable game snapshot (score, entity positions/counts,
    whatever the game registers via `__test.expose(fn)`);
  - `__test.tick(n)` — advance the simulation n fixed steps deterministically (rendering may
    be skipped);
  - `__test.seed(s)` — set the RNG seed (the template ships a seedable PRNG; games must use
    it, never `Math.random`, when `?test=1`);
  - `__test.input(action, pressed)` — inject a named input action;
  - `__test.errors` — array of uncaught errors/console.error payloads captured since load.
  All headless verification drives the game through this hook — state, not pixels.

Every structural rule above is written in the template as a short comment where it lives, so
implementers editing the file see the rule at the point of temptation.

### 2. `tools/verify/` — deterministic verifiers

Node scripts (Node 20+, Playwright as the only heavyweight dependency, headless Chromium),
each exiting non-zero on failure, all runnable via one `npm run verify -- <game-dir>`:

- **`smoke.js`** — loads the game with `?test=1`, waits for `MENU`, asserts `__test.errors`
  is empty, starts the game via injected input, ticks 600 steps, asserts state is sane and
  errors are still empty.
- **`journey.js`** — walks the full state graph via injected inputs (menu → playing → paused
  → playing → game over → restart), asserting after each transition that (a) the state
  changed and (b) the snapshot actually changed in a way that proves gameplay advanced
  (positions/score/timers moved) — transitions that update state fields but freeze gameplay
  are the target bug class.
- **`determinism.js`** — same seed + same scripted inputs run twice ⇒ identical final
  snapshots; catches hidden `Math.random`/time dependencies that make every other verifier
  flaky.
- **`budget.js`** — enforces per-game budgets from a `budgets.json` the game dir may carry
  (defaults in the tool): max single-file size, max total dir size, and — when a game dir
  contains `assets/` — per-model triangle/file-size caps for `.glb` files (parse the GLB
  header/JSON chunk; no rendering needed) and a required clean rig check flag in the asset's
  sidecar metadata (see spec-template §assets).

### 3. `tools/playtest/` — the playtest harness

`npm run playtest -- <game-dir>` (Playwright, headed-capable but headless by default):

- Plays the game twice: once with the scripted probe the game dir declares
  (`playtest.probe.js` — exported input script hitting the core mechanic), once with a
  bounded exploratory session (random-ish action mashing, seeded).
- Captures: screenshots at every state transition plus every 5 seconds of play, an FPS
  sample series (via rAF timestamps), the final snapshots, and `__test.errors`.
- Emits `playtest-report/` in the game dir: the screenshots plus `report.json` (states
  visited, fps stats, errors, snapshot digests) and `report.md` — pre-filled sections the
  reviewing agent completes: **what was played, what worked, confusion/clarity findings as a
  severity table (blocker/major/minor), and explicit non-findings** ("controls discoverable
  without instructions: yes/no"). The template must state plainly: *fun is judged by the
  human who merges, not by this report* — the report carries evidence (screenshots, numbers,
  confusion findings), never a fun score.

### 4. `tests/regression/` — the permanent suite

- `tests/regression/README.md` states the rule: **every bug that ships in any game becomes a
  minimal regression test here, named `<game>-<short-slug>.test.js`, and the suite never
  shrinks.** Tests drive games through `__test` exactly like the verifiers.
- `npm run regression` runs the whole suite against the games in `games/`.
- Ships with at least one real example: a regression test against the fixture game (pick a
  plausible bug class — e.g. "restart after game over must reset score and entity state" —
  and test it).

### 5. `games/fixture-pong/` — the fixture that proves the substrate

A deliberately minimal one-screen game (pong-like or equivalent single-mechanic game) built
FROM the template, exercising every hook: seedable RNG, snapshot exposure, a probe script,
budgets file. It exists to prove the tooling, not to be fun. Acceptance runs against it.

### 6. `docs/spec-template.md` — the template future game tasks are written from

The document a poster copies to write a game task spec. Required sections, each with one
sentence of guidance and a filled example:

- **Concept** (one paragraph, the game in a sentence, the platform: desktop/mobile/both);
- **Feel contract** — 3–5 atomic, observable statements about the signature mechanic (e.g.
  "the ball visibly accelerates after each paddle hit; a rally of 10+ hits feels frantic"),
  marked UNCUTTABLE: implementations may cut scope anywhere else, never here;
- **Mechanics & states** — rules, win/lose conditions, the state graph if it extends the
  template's;
- **Assets** (when any) — for 3D/GLB assets: source, triangle budget, required animations by
  name, the rig-check requirement, and the sidecar metadata file (`<asset>.meta.json`:
  provenance — tool, prompt, model/version — plus declared tri count and rig status);
- **Verification** — "verify + regression green, playtest report attached to the PR" is
  standing; add game-specific probes worth scripting;
- **Preview** — a live playable URL is required at delivery (the network's preview discipline
  applies; static bundles make this trivial);
- **Budgets** — the `budgets.json` values for this game;
- **Non-goals** — what reviewers should not expect.

### 7. Repo surface

- `README.md` — what this repository is, the layout, the three npm scripts
  (`verify`, `playtest`, `regression`), how a delivered game PR is reviewed (verify output +
  playtest report + playing the preview), and the regression rule.
- `package.json` with the three scripts wired; `npm ci && npm run verify -- games/fixture-pong`
  works from a fresh clone.
- `.github/workflows/verify.yml` — on every PR: `npm ci`, verify + regression on every dir in
  `games/`, and playtest on changed game dirs, uploading `playtest-report/` as an artifact.
  Keep it under 5 minutes.

## Constraints

- Games: single self-contained HTML file from the template, zero runtime dependencies, no
  network at play time. Tooling: Node 20+, Playwright, nothing else heavyweight.
- No git-LFS in this task (asset budgets keep binaries small; revisit if a task's assets
  demand it).
- Static hosting must be sufficient for any game and for previews (a game dir is servable
  as-is by any static file server).

## Acceptance

From a fresh clone, in order, all green:

1. `npm ci`
2. `npm run verify -- games/fixture-pong` (all four verifiers pass)
3. `npm run regression`
4. `npm run playtest -- games/fixture-pong` produces `playtest-report/` with screenshots,
   `report.json`, and a completed `report.md`
5. The CI workflow passes on the delivering PR itself — the PR is its own first proof.

## Non-goals

No real game beyond the fixture. No 3D assets yet (the budget/rig checks ship dormant and
are proven by unit-testing `budget.js` against a tiny checked-in GLB fixture under
`tools/verify/fixtures/`). No LFS, no deployment automation beyond the preview discipline,
no fun scoring anywhere.
