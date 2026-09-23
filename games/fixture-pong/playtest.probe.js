// Scripted playtest probe for games/fixture-pong — runner contract:
// per step, in order: if `action` is present, __test.input(action, pressed !== false);
// if `ticks` is present, __test.tick(ticks); if `waitMs` is present, wait that long.
//
// Assumes a fresh load of index.html?test=1 sitting in MENU with the DEFAULT
// PRNG seed (the template seeds a constant, so an unseeded fresh load is
// deterministic). The paddle is "parked" at each landing point ahead of the
// ball's arrival, so a few stray real-time frames between steps cannot break
// the rallies. Landing schedule under the default seed (fixture ticks since
// serve): hit 1 @ tick 32 x≈141.6, hit 2 @ 168 x≈116.3, hit 3 @ 304 x≈364.5;
// with the paddle parked at the left wall afterwards, the three misses land at
// ticks 448/487/526 → GAME_OVER.
module.exports = {
  name: 'fixture-pong: serve, three rallies, pause/unpause, run on to game over',
  steps: [
    // MENU → PLAYING: press primary to serve, then release.
    { action: 'primary', ticks: 2 },
    { action: 'primary', pressed: false, ticks: 1 },

    // Rally 1: park under the serve (x≈141.6, arrives tick 32). 12 ticks of
    // left at 300px/s moves the paddle 200 → 140.
    { action: 'left', ticks: 12 },
    { action: 'left', pressed: false, ticks: 25 },

    // Rally 2: return lands at x≈116.3 on tick 168. Nudge 140 → 115 and wait.
    { action: 'left', ticks: 5 },
    { action: 'left', pressed: false, ticks: 130 },

    // Rally 3: return lands at x≈364.5 on tick 304. Anchor against the right
    // wall (clamped at x=370), which absorbs any accumulated drift.
    { action: 'right', ticks: 60 },
    { action: 'right', pressed: false, ticks: 75 },

    // Pause, then resume (PLAYING → PAUSED → PLAYING). Paused ticks do not
    // advance the ball, so the ending schedule below is unaffected.
    { action: 'pause', ticks: 4 },
    { action: 'pause', pressed: false, ticks: 4 },
    { action: 'pause', ticks: 4 },
    { action: 'pause', pressed: false, ticks: 4 },

    // Park at the left wall, out of the ball's way, and run on to GAME_OVER
    // (three misses; the last lands around fixture tick 526).
    { action: 'left', ticks: 90 },
    { action: 'left', pressed: false },
    { ticks: 260 },
  ],
};
