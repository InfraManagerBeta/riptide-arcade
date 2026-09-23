# 002 — Mascot pack: three rigged GLB mascots

The arcade shell needs three game-ready 3D mascots to dress the cabinet
frame and the game-over screens:

1. **Crab bruiser** — squat, heavy-clawed, cartoon-menacing.
2. **Seagull scout** — lanky, alert, slightly unhinged.
3. **Buoy-bot referee** — a bell-buoy robot with a striped whistle arm.

## Deliverables

- `assets/mascots/crab.glb`, `assets/mascots/gull.glb`,
  `assets/mascots/buoy.glb` — each **rigged** with at least one looping
  idle animation, PBR textures, and **≤ 10,000 triangles**.
- The assets are to be **generated with a text/image-to-3D tool** (e.g.
  Tripo3D) — not hand-modeled, not sourced from asset libraries.
- **Provenance sidecar per asset** (project conduct): each
  `assets/mascots/<name>.provenance.json` names the generating tool,
  model/version, and the prompt used. Credentials never appear in any
  artifact, log, or commit — refer to credentials by environment
  variable name only.
- **External API usage is session-reported**: whoever runs the
  generation reports units consumed (tasks submitted, credits spent)
  and an estimated cost, labeled as an estimate, in their completion
  notes.
- `scripts/validate-mascots.mjs` — parses each GLB and fails unless it
  has ≥ 1 skin, ≥ 1 animation, and ≤ 10,000 triangles. Wire it into CI;
  green means all three assets pass.
- A `README.md` section documenting the generation pipeline and how to
  re-run validation.

## Out of scope

- In-game integration (loading the mascots into a running scene).
- Sound, voice, or particle effects.
