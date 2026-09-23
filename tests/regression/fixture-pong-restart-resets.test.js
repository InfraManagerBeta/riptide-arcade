'use strict';
/* =============================================================================
 * Regression: fixture-pong — restart after GAME_OVER must COMPLETELY reset the
 * run state.
 *
 * BUG CLASS GUARDED: the half-reset restart. A restart handler that resets
 * SOME run state (e.g. lives) but leaks the rest (score, run tick counter,
 * ball position/velocity, entity list) from the previous run. This ships
 * easily because a half-reset game still LOOKS restarted for the first second
 * of play — and a test that only asserts fields "changed" also passes on it.
 * This test therefore asserts every field against its REAL reset value, never
 * against mere inequality.
 *
 * Real reset values (from games/fixture-pong/index.html startRun()/serve()):
 *   score 0, lives 3 (START_LIVES), ticks 0 (runTicks), paddle.x 200
 *   (FIELD_W/2), ball at (200, 150) (field centre), ball.vy 240
 *   (BALL_SPEED_Y, downward), |ball.vx| in [100, 150] (SERVE_VX_MIN/MAX),
 *   entityCount 2 (paddle + active ball; 1 at GAME_OVER when the ball leaves
 *   play).
 *
 * The whole drive runs inside ONE page.evaluate: the live rAF loop advances
 * real time between separate evaluate calls, so any sequence that must be
 * reproducible has to happen synchronously from a fresh load.
 * ========================================================================== */

module.exports = {
  name: 'fixture-pong-restart-resets',
  game: 'fixture-pong',
  run: async ({ page, openGame, assert }) => {
    await openGame('fixture-pong');

    const data = await page.evaluate(() => {
      const t = window.__test;
      const out = {};
      t.seed(1337); // fixed seed: the whole drive below is deterministic

      // MENU -> PLAYING. Edge semantics: justPressed compares against the
      // previous fixed tick, so release before any later press.
      t.input('primary', true);
      t.tick(1);
      t.input('primary', false);
      t.tick(1);
      out.afterStartState = t.state();

      // Score a few points by chasing the ball with the paddle, so the score
      // at GAME_OVER is nonzero — otherwise "score resets to 0" would be
      // vacuously true and a score leak would slip through.
      let guard = 0;
      while (t.state() === 'PLAYING' && t.snapshot().score < 3 && guard++ < 2000) {
        const s = t.snapshot();
        t.input('left', s.paddle.x > s.ball.x + 2);
        t.input('right', s.paddle.x < s.ball.x - 2);
        t.tick(1);
      }
      // Park the paddle at the left wall and idle to GAME_OVER (serve angles
      // guarantee a stationary paddle misses; three misses end the run).
      t.input('right', false);
      t.input('left', true);
      guard = 0;
      while (t.state() === 'PLAYING' && guard++ < 3000) t.tick(1);
      t.input('left', false);
      t.tick(1); // settle the released edge before the restart press
      out.gameOverState = t.state();
      out.gameOver = t.snapshot();

      // Restart from GAME_OVER with primary (fresh rising edge).
      t.input('primary', true);
      t.tick(1); // the tick that consumes the press and re-enters PLAYING
      t.input('primary', false);
      out.restartState = t.state();
      out.afterRestart = t.snapshot(); // snapshot at the instant of restart

      // A few more ticks: the new run must actually be simulating.
      t.tick(5);
      out.afterFiveTicks = t.snapshot();

      out.errors = t.errors.slice();
      return out;
    });

    // ---- Preconditions: the drive really did play a run and end it ----------
    assert.equal(data.afterStartState, 'PLAYING', 'precondition: primary must start a run from MENU');
    assert.equal(data.gameOverState, 'GAME_OVER', 'precondition: idling must reach GAME_OVER');
    assert.ok(data.gameOver.score >= 3,
      `precondition: score at GAME_OVER must be nonzero so the reset check is meaningful (got ${data.gameOver.score})`);
    assert.equal(data.gameOver.lives, 0, 'precondition: GAME_OVER means 0 lives');
    assert.equal(data.gameOver.entityCount, 1, 'precondition: ball leaves play at GAME_OVER (paddle only)');

    // ---- The regression: the restart must be a COMPLETE reset ---------------
    // Every assertion is against the real reset value — "changed since game
    // over" would pass on a half-reset, which is exactly the bug.
    assert.equal(data.restartState, 'PLAYING', 'state: primary from GAME_OVER must re-enter PLAYING');
    assert.equal(data.afterRestart.score, 0, 'score: must reset to 0 on restart');
    assert.equal(data.afterRestart.lives, 3, 'lives: must reset to full (3) on restart');
    assert.equal(data.afterRestart.ticks, 0, 'ticks: the run tick counter must reset to 0 on restart');
    assert.equal(data.afterRestart.paddle.x, 200, 'paddle.x: must recentre to 200 (FIELD_W/2) on restart');
    assert.equal(data.afterRestart.ball.x, 200, 'ball.x: must reposition to field centre x=200 on restart');
    assert.equal(data.afterRestart.ball.y, 150, 'ball.y: must reposition to field centre y=150 on restart');
    assert.equal(data.afterRestart.ball.vy, 240, 'ball.vy: serve must relaunch the ball downward at 240');
    assert.ok(Math.abs(data.afterRestart.ball.vx) >= 100 && Math.abs(data.afterRestart.ball.vx) <= 150,
      `ball.vx: serve speed must be in [100,150] (got ${data.afterRestart.ball.vx})`);
    assert.equal(data.afterRestart.entityCount, 2, 'entityCount: must be back to the playing value (paddle + active ball)');

    // Moving, not frozen: after 5 ticks the new run has advanced.
    assert.equal(data.afterFiveTicks.ticks, 5, 'ticks: the new run must be counting fixed steps again');
    assert.ok(data.afterFiveTicks.ball.y > 150,
      `ball: must be moving after restart, not frozen at its reset position (y stayed ${data.afterFiveTicks.ball.y})`);

    assert.equal(data.errors.length, 0,
      `__test.errors must stay empty through game over and restart, got: ${JSON.stringify(data.errors)}`);
  },
};
