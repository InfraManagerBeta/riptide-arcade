# tests/regression/ — the permanent regression suite

## THE RULE

**Every bug that ships in any game becomes a minimal regression test here, named
`<game>-<short-slug>.test.js`, and the suite never shrinks.**

- Tests are **never deleted** and **never weakened** to make a build pass.
- A test may only change if the spec it encodes changed — and the change must say so.
- "Minimal" means the smallest drive that reproduces the shipped bug and asserts the
  fixed behaviour against **real values** (a test that only asserts something "changed"
  passes on a half-fix; assert what the value must actually be).

Run the whole suite with:

```
npm run regression
```

It discovers every `*.test.js` in this directory, runs them all (one failure never stops
the others), prints a per-test PASS/FAIL table with durations, and exits non-zero if any
test failed. The suite also runs `node tools/verify/budget.selftest.js` as its own row
when that file exists (SKIPPED with a reason when it does not).

## How tests drive games

Exactly like the verifiers: through the **`window.__test`** hook, state — never pixels.
The runner serves the repo root over a local HTTP server on `127.0.0.1` (never
`file://`) and opens `games/<game>/index.html?test=1`, which is the one condition under
which `window.__test` exists:

- `__test.state()` → `LOADING | MENU | PLAYING | PAUSED | GAME_OVER`
- `__test.snapshot()` → JSON-safe object (template fields + what the game exposes)
- `__test.tick(n)` → advance exactly n fixed steps (dt = 1/60) synchronously
- `__test.seed(s)` → reseed the PRNG (seed before the run starts)
- `__test.input(action, pressed)` → inject `left right up down primary pause`
- `__test.errors` → array of captured `{ type, message, stack? }`

Two rules of the road:

1. **Edge semantics** — `justPressed` compares against the previous fixed tick. Release
   an action (`input(a, false)` + a tick) before pressing it again, or the second press
   has no edge.
2. **One `page.evaluate`** — the live rAF loop advances real time between separate
   `page.evaluate` calls. Any sequence that must be reproducible belongs inside ONE
   `page.evaluate` from a fresh load: seed, drive, capture, return the data, assert in
   Node.

## The test-module contract (pinned)

Each `*.test.js` is CommonJS exporting:

```js
module.exports = {
  name: 'string',            // test name shown in the summary table
  game: 'string',            // the games/<game>/ directory it exercises
  run: async (ctx) => {},    // the test body; fails by THROWING
};
```

`ctx` provides at least `{ page, openGame, assert }`:

- `page` — a fresh Playwright `Page` in its own browser context (tests are isolated;
  the chromium instance is shared across the suite).
- `openGame(gameName, { query } = {})` — navigates to
  `games/<gameName>/index.html?test=1` (extra query params merged in), waits until
  `window.__test` exists and the state has left `LOADING`, and resolves with the page.
- `assert` — Node's built-in `assert/strict`.

A test fails by throwing (any `assert` throw counts). The runner reports the failure
message plus, best-effort, the game state and snapshot at the moment of failure — put
the field name in your assertion message so the table names the leak.

## How to add a test (5 lines)

1. Reproduce the shipped bug and identify the smallest `__test` drive that shows it.
2. Create `tests/regression/<game>-<short-slug>.test.js` from the skeleton below.
3. Drive the game inside ONE `page.evaluate`; return the captured data.
4. Assert against the real expected values (never just "changed"), naming each field.
5. Run `node tests/regression/run.js <short-slug>` until green, then `npm run regression`.

### Skeleton (copy-paste)

```js
'use strict';
// Regression: <game> — <one line: the shipped bug this guards against>.
module.exports = {
  name: '<game>-<short-slug>',
  game: '<game>',
  run: async ({ page, openGame, assert }) => {
    await openGame('<game>');
    const data = await page.evaluate(() => {
      const t = window.__test;
      t.seed(1337);
      t.input('primary', true); t.tick(1); t.input('primary', false); t.tick(1);
      // ... drive the bug's scenario with t.input()/t.tick() ...
      return { state: t.state(), snap: t.snapshot(), errors: t.errors.slice() };
    });
    assert.equal(data.state, 'PLAYING', 'state: <what it must be and why>');
    assert.equal(data.snap.score, 0, 'score: <the real expected value>');
    assert.equal(data.errors.length, 0, `errors: ${JSON.stringify(data.errors)}`);
  },
};
```

## Running one test alone

Pass any substring of the test name, its game, or its filename:

```
node tests/regression/run.js fixture-pong           # everything for one game
node tests/regression/run.js restart-resets         # one test by slug
```

Filters also apply to the `budget.selftest` row (`node tests/regression/run.js budget.selftest`).

### Plumbing for negative controls

`--games-root <dir>` makes the runner serve `/games/<name>/...` from `<dir>/<name>/...`
instead of the repo's `games/`. Use it to point a test at a deliberately broken COPY of
a game (never mutate the repo's game) and prove the test actually fails on the bug it
guards:

```
cp -r games/fixture-pong /tmp/broken-games/fixture-pong   # then break the copy
node tests/regression/run.js --games-root /tmp/broken-games fixture-pong
```
