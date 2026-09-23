# Game task spec template

**How to use this.** Copy this file to `specs/NNN-<slug>.md` (next free number, short slug for
the game). Fill every section — delete nothing, including sections that do not apply to your
game; a section that does not apply still needs an explicit statement saying so (see the
Assets section below for the exact wording when a game ships no assets). Rival workers deliver
against this spec, and the poster reviews against it, so anything left vague becomes a dispute
at review time instead of a decision made once, up front, by the poster.

The eight sections below are required, in this order. Each one opens with a guidance line in
*italics* stating what belongs there, followed by a filled example under **Example**. The
examples all describe one imaginary game, **Comet Catcher**, so they read as a single
consistent spec rather than eight unrelated fragments — do not copy the example content into a
real spec, only the shape.

---

## 1. Concept

*One paragraph: the game in a sentence, then the platform (desktop / mobile / both).*

**Example**

Comet Catcher is a one-screen arcade game where the player sweeps a net back and forth along a
rooftop to catch falling comets for points while dodging bats that steal points on contact.
Platform: both — keyboard on desktop, touch drag + tap on mobile, same build.

## 2. Feel contract

*3–5 atomic, OBSERVABLE statements about the signature mechanic, marked **UNCUTTABLE**:
implementations may cut scope anywhere else in the spec, never here. Each statement must be
checkable by a human in under a minute of play — if you cannot point at the screen and say
"yes, that happened" or "no, it didn't," it does not belong in this section. Vague adjectives
("juicy", "fun", "satisfying", "polished") are not feel-contract statements; describe the
observable effect that is supposed to produce that feeling instead.*

**Example — UNCUTTABLE**

1. The net visibly widens within 250 ms of pressing `primary` and narrows back on release —
   a human watching can tell exactly when a catch attempt is active.
2. Every successful catch spawns a particle burst at the catch point, visible for at least
   3 frames, with no exceptions.
3. A missed comet (falls past the net) triggers a red flash at the screen edges lasting
   exactly 2 rendered frames, visually distinct from the white/gold flash on a successful catch.
4. Comet fall speed visibly increases every 10 comets caught; a human watching a continuous
   10-second window straddling that threshold can tell the speed changed without looking at
   the score.
5. A catch streak of 5 or more in a row shows a combo banner for exactly 1 second that never
   blocks or delays gameplay input.

## 3. Mechanics & states

*Rules, win/lose conditions, and the state graph if it extends the template's
(`LOADING → MENU → PLAYING → PAUSED / GAME_OVER`). Include the input-action mapping the game
uses from the canonical set (`left`, `right`, `up`, `down`, `primary`, `pause`) — list every
canonical action the game binds, and say plainly when an action is intentionally unused.*

**Example**

Rules: comets fall from random x-positions at the top of the screen at a rate that increases
with score; the net is a fixed-width zone that the player slides horizontally; pressing
`primary` widens the net for 250 ms, the only window in which a comet overlapping the net
counts as caught. Bats fall on the same lanes at a lower rate and always count as a hit if they
touch the net, regardless of `primary` state.

Win: catch 30 comets. Lose: 5 missed comets, or 3 bat hits, whichever comes first.

State graph: unextended — exactly `LOADING → MENU → PLAYING → PAUSED / GAME_OVER`.

Input mapping:

| Canonical action | Effect in Comet Catcher |
|---|---|
| `left` | Slide net left |
| `right` | Slide net right |
| `up` | Unused |
| `down` | Unused |
| `primary` | Widen net (catch window) |
| `pause` | Toggle `PLAYING` ↔ `PAUSED` |

## 4. Assets

*When the game has no assets beyond the template shell, write "None." here and stop — the
budget verifier's GLB checks stay dormant when a game dir carries no `.glb` files, and that is
the expected, correct state for most game tasks. When a game does ship a 3D/GLB asset, give:
the source (how it was produced), the triangle budget, the required animation clip names, the
rig-check requirement, and the sidecar metadata file the asset must ship alongside it
(`<asset>.meta.json`, carrying provenance — tool, prompt, model/version — plus the asset's own
declared triangle count and rig status).*

**Example**

Comet Catcher ships one 3D asset: the bat enemy, `assets/bat.glb`, rendered as a small rigged
mascot rather than a flat sprite.

- Source: generated with a text-to-3D tool, not hand-modeled.
- Triangle budget: 1,200 triangles max.
- Required animation clips (by name, exactly): `idle`, `fly_loop`, `hit_react`.
- Rig check required: yes — single skeleton root, no unused bones, every vertex weighted.
- Sidecar file: `assets/bat.glb.meta.json`, containing:

```json
{
  "provenance": {
    "tool": "Meshy",
    "prompt": "small cartoon bat with lantern-lit wings, low-poly, game-ready, T-pose",
    "model": "meshy-4"
  },
  "declaredTriangles": 1180,
  "rigStatus": "clean"
}
```

The declared triangle count and rig status here are asserted by whoever produced the asset;
`tools/verify/budget.js` checks the GLB's actual triangle count against both the declared value
and the game's `budgets.json` cap, and fails if the sidecar's `rigStatus` is not `"clean"` when
`budgets.json` requires a rig check.

## 5. Verification

*"`npm run verify` + `npm run regression` green, and a playtest report attached to the PR" is
standing for every game task — do not restate it as if it were specific to this game. This
section exists only to name the game-specific probes worth scripting on top of that baseline:
list two or three concrete probes and, for each, what it proves.*

**Example**

Standing: `npm run verify -- games/comet-catcher` and `npm run regression` both green; a
playtest report attached to the delivering PR.

Game-specific probes:

1. **Catch-and-speed-up** — script 10 consecutive catches; assert the exposed `fallSpeed`
   snapshot field is strictly higher after the 10th catch than before the 1st. Proves the
   speed-up in feel-contract statement 4 actually fires, not just that the number exists.
2. **Miss-to-game-over** — script 5 deliberate misses (net held away from each comet's landing
   x); assert state transitions `PLAYING → GAME_OVER` and the snapshot's `missedCount` reads 5
   at that transition, not before or after. Proves the lose condition is exact, not off-by-one.
3. **Combo timing** — script 5 consecutive catches, then tick forward exactly the number of
   fixed steps equal to 1 simulated second; assert the snapshot's `comboActive` flag is `true`
   immediately after the 5th catch and `false` once that many ticks have elapsed. Proves the
   combo banner in feel-contract statement 5 has a real, bounded duration rather than lingering
   or vanishing early.

## 6. Preview

*A live playable URL is required at delivery — static bundles make this trivial, since a game
dir is servable as-is by any static file server. Name a concrete recipe for producing that URL
on the delivering fork/branch.*

**Example**

Enable GitHub Pages on the delivering fork, serving from the delivering branch, and link the
preview at `https://<fork-owner>.github.io/riptide-arcade/games/comet-catcher/` in the PR
description. No build step is required before the page is servable — the game dir is pushed
as-is.

## 7. Budgets

*The `budgets.json` values for this game, as a fenced JSON block matching the verifier's
contract exactly (all keys optional; omit any the game does not need). Add a sentence on how
the values were picked — tie them to what the game actually ships, not a round default.*

**Example**

```json
{
  "maxSingleFileBytes": 200000,
  "maxTotalDirBytes": 3000000,
  "glb": {
    "maxTriangles": 1200,
    "maxFileBytes": 500000,
    "requireRigCheck": true
  }
}
```

`maxSingleFileBytes` covers `index.html` staying a single readable file well under a quarter
megabyte with no build step; `maxTotalDirBytes` leaves headroom for the one small GLB mascot
plus its sidecar and any sound assets; the `glb` caps mirror the triangle budget and rig-check
requirement stated in the Assets section above, so the two sections cannot drift apart.

## 8. Non-goals

*What reviewers should NOT expect — 3–4 crisp bullets, honest about scope cut anywhere except
the feel contract.*

**Example**

- No persistent save or leaderboard — the high score resets on page reload.
- No multiplayer or networked play of any kind.
- No settings/difficulty menu beyond what the template already provides (pause,
  `prefers-reduced-motion`).
- No native app wrapper or haptics — browser touch input only, on the mobile platform.

---

## Before posting this task — checklist

- Every section above is filled; none are left as "TBD" or copied verbatim from this template.
- The feel contract is atomic, observable, and each statement is checkable in under a minute
  of play — no adjectives standing in for a mechanism.
- The Budgets section is valid JSON matching the verifier's key names exactly.
- The Preview section names a concrete recipe, not just "a URL will be provided."
- The Non-goals section is honest — it says what will actually be missing, not a hedge.
