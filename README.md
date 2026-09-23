# Riptide Arcade

A factory for small static browser games, built as tasks on a Riptide network: each game is
one posted task referencing a spec in `specs/`, agent workers deliver rival pull requests, and
the poster reviews by running the verifiers, reading the playtest report, and **playing the
preview** — and pays by merging.

Games are single self-contained HTML files built from `templates/base-game.html`. Everything a
game does at play time runs statically — no server, no build step, no network calls. The Node
tooling in this repository (verifiers, playtest harness, regression suite) runs only at
development and review time; it never ships with a game.

## Layout

```
riptide-arcade/
├── templates/
│   └── base-game.html          # the opinionated shell every game starts from
├── tools/
│   ├── verify/
│   │   ├── smoke.js            # loads the game, starts it, ticks it, checks for errors
│   │   ├── journey.js          # walks the full state graph, checks gameplay actually advances
│   │   ├── determinism.js      # same seed + same inputs twice ⇒ identical snapshots
│   │   └── budget.js           # enforces games/<game>/budgets.json (file size, GLB caps)
│   └── playtest/                # the scripted + exploratory playtest harness
├── tests/
│   └── regression/               # the permanent regression suite (see below)
├── games/
│   └── <game-name>/
│       ├── index.html            # the game's entry file, servable as-is
│       ├── budgets.json          # optional per-game size/asset budgets
│       └── playtest.probe.js     # scripted input probe hitting the core mechanic
├── docs/
│   └── spec-template.md          # copy this to write a new game-task spec
├── specs/
│   └── NNN-<slug>.md             # one spec per game task, written from the template
├── .github/
│   └── workflows/                 # CI: verify + regression + playtest on every PR
├── package.json
└── README.md
```

## The three scripts

Requires Node 20+. Before the first run: `npm ci`, then `npx playwright install chromium`
(Playwright/headless Chromium is the sole heavyweight dependency; games themselves have zero
runtime dependencies).

| Command | What it proves |
|---|---|
| `npm run verify -- games/<game>` | Smoke, state-graph journey, determinism, and budget checks all pass for that game dir. |
| `npm run regression` | The permanent regression suite still passes against every game under `games/`. |
| `npm run playtest -- games/<game>` | Runs the game's scripted probe plus a seeded exploratory session and writes `playtest-report/` in the game dir. |

Each script exits non-zero on failure — a failing verifier, a failing regression test, or a
playtest run that hits an uncaught error all fail the command and, in CI, the PR check.

## Building a game

1. Start from `templates/base-game.html` and keep its structure intact: the fixed-timestep
   loop, the single `setState` chokepoint (never assign the state variable directly anywhere
   else), the audio lifecycle rules (`resetAudioState()` on transitions,
   `updateContinuousAudio()` called unconditionally every frame before any state-guarded early
   return), and the input mapping layer (games read named actions, never raw keyboard/pointer
   events).
2. Use the template's seedable RNG for all gameplay randomness — never `Math.random` — so the
   game is deterministic under `?test=1` with a fixed seed.
3. Register every field the game wants visible to verification via `__test.expose(fn)`, so
   `__test.snapshot()` reflects real gameplay state (score, positions, timers, whatever a
   verifier or regression test needs to assert against).
4. Ship `games/<game>/budgets.json` (defaults apply for any key you omit) and
   `games/<game>/playtest.probe.js` (a scripted input sequence exercising the core mechanic)
   alongside `index.html`.

## How a delivered game PR is reviewed

The poster reviews a delivered game by:

1. Running `npm run verify -- games/<game>` and `npm run regression` and confirming both are
   green.
2. Reading the playtest report (`playtest-report/report.md` plus its screenshots) attached to
   the PR — what was played, what worked, and any confusion/clarity findings.
3. Playing the live preview themselves.

**Fun is judged by the human who merges, never by a report or a score.** The playtest report
carries evidence — screenshots, FPS numbers, state coverage, confusion findings — never a
verdict on whether the game is fun.

## The regression rule

Every bug that ships in any game becomes a minimal regression test in `tests/regression/`,
named `<game>-<short-slug>.test.js`, driving the game through `__test` exactly like the
verifiers do. **The suite never shrinks** — regression tests are not deleted or weakened to
make a later change pass.

## Writing a new game task

See [`docs/spec-template.md`](docs/spec-template.md) for the template every game-task spec is
written from, including a fully worked example.
