// games/fixture-pong/verify.hints.js — OPTIONAL per-game hint for
// tools/verify/journey.js's PLAYING -> GAME_OVER transition.
//
// Contract (see tools/verify/journey.js header): CommonJS,
//   module.exports = { toGameOver: Step[], restart?: Step[] }
// `Step` is the SAME shape tools/playtest already uses:
//   { action?: string, pressed?: boolean, ticks?: number, waitMs?: number }
// applied in order per step: inject action -> tick -> wait.
//
// fixture-pong CAN lose while idle (see index.html's serve-angle comment),
// so this file is not strictly required for it to pass journey.js — it
// exists so the repo's own acceptance run genuinely exercises the hinted
// path too, not just the bounded-idle-tick fallback.
//
// Strategy: hold `left` long enough for the paddle to clamp at the far left
// wall (paddle speed 300px/s, FIXED_DT 1/60s -> 5px/tick; center-to-wall is
// (200-30)/5 = 34 ticks, so 40 is comfortably enough), release, then run
// enough ticks for all 3 lives to be lost. Every serve starts the ball at
// the field's horizontal center (x=200) with |vx| in [100,150], so by the
// time it reaches the paddle's y it has drifted at least ~54px off-center —
// always outside the now-parked paddle's [0,60] span — so every serve
// misses regardless of the serve's random direction. 1600 ticks is well
// over the ~530 ticks fixture-pong needs for three misses from one serve,
// leaving headroom for the extra re-serves this hint forces.
module.exports = {
  toGameOver: [
    { action: 'left', pressed: true, ticks: 40 },
    { action: 'left', pressed: false, ticks: 1600 },
  ],
};
