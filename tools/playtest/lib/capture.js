// Screenshot capture manager shared by both the probe run and the
// exploratory run. Two independent triggers, per the work order:
//   1. a shot on every __test.state() TRANSITION (polled frequently);
//   2. a shot every PERIODIC_SECONDS of accumulated PLAY time, i.e. of the
//      game actually being in PLAYING — never wall-clock time, and never
//      while MENU/PAUSED/GAME_OVER (those states already get a transition
//      shot each).
//
// "Play time" is accumulated from two additive sources, per the fix design:
//   (a) fixed steps executed via __test.tick(n) while the state was PLAYING
//       going into that batch of ticks — each worth FIXED_DT (1/60s) of
//       SIMULATED time, since __test.tick() costs no real wall clock
//       (recordTicks(), called by probeRunner right after each tick batch);
//   (b) real wall-clock time that elapses between polls while the state was
//       PLAYING for that whole interval (poll()'s own bookkeeping) — this is
//       what lets the exploratory run (which never calls __test.tick()
//       directly; the page's own rAF loop drives it in real time) accumulate
//       play time at all.
// Both sources feed the SAME accumulator (this.playSeconds); the periodic
// cadence fires off that one number, so a probe run (all synthetic ticks, ~0
// wall clock) and an exploratory run (all real wall clock, no manual ticks)
// are both covered by the identical mechanism.
'use strict';

const path = require('path');

const FIXED_DT = 1 / 60; // must match templates/base-game.html's FIXED_DT

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CaptureSession {
  constructor({ page, outDir, prefix, periodicMs = 5000, pollMs = 100 }) {
    this.page = page;
    this.outDir = outDir;
    this.prefix = prefix;
    this.periodicSeconds = periodicMs / 1000;
    this.pollMs = pollMs;

    this.lastState = null;
    this.statesVisited = [];
    this.transitionShots = [];
    this.periodicShots = [];
    // Parallel array to periodicShots: the accumulated play-seconds value at
    // the moment each periodic shot was taken — the audit trail report.json
    // exposes (see index.js), so the cadence is checkable, not trusted.
    this.periodicShotsPlaySeconds = [];
    this.transitionIdx = 0;
    this.periodicIdx = 0;
    this.startTime = Date.now();

    // Play-time accumulator (seconds) — see file header. Only ever advances
    // while `lastState === 'PLAYING'`, by construction of recordTicks() and
    // poll() below, so periodic cadence can never fire outside PLAYING.
    this.playSeconds = 0;
    this.lastPeriodicPlaySeconds = 0;
    this.lastPollTime = this.startTime;
  }

  async _readState() {
    return this.page.evaluate(() => (window.__test ? window.__test.state() : null));
  }

  // Called right after driving n synthetic __test.tick() steps (probeRunner
  // does this once per tick-chunk). Credits n*FIXED_DT of SIMULATED play
  // time if the game was PLAYING going into that batch — the state as of
  // the most recent poll() (ticks between polls cost no wall clock, so this
  // is the only place that time is otherwise ever recorded).
  recordTicks(n) {
    if (this.lastState !== 'PLAYING') return;
    const count = Math.max(0, Math.floor(Number(n) || 0));
    this.playSeconds += count * FIXED_DT;
  }

  // One immediate check: shoot on state change, shoot on periodic play-time
  // cadence. Safe to call as often as you like — cheap no-op when nothing
  // fired.
  async poll() {
    const now = Date.now();
    // Wall-clock contribution: real time elapsed since the last poll,
    // credited to play time only if the game was already PLAYING for that
    // whole interval (this is what the exploratory run's real-time rAF play
    // accumulates through — it never calls __test.tick() itself).
    if (this.lastState === 'PLAYING') {
      this.playSeconds += (now - this.lastPollTime) / 1000;
    }
    this.lastPollTime = now;

    const state = await this._readState();
    if (state !== this.lastState) {
      const fromLabel = this.lastState || 'START';
      this.transitionIdx += 1;
      const filename = `${this.prefix}-${String(this.transitionIdx).padStart(2, '0')}-${fromLabel}-to-${state}.png`;
      await this.page.screenshot({ path: path.join(this.outDir, filename) });
      this.transitionShots.push(filename);
      this.statesVisited.push(state);
      this.lastState = state;
    }

    // Periodic "of play" shot — PLAYING only (MENU/PAUSED/GAME_OVER are
    // already covered by transition shots), keyed to accumulated play
    // seconds crossing another multiple of the cadence.
    if (state === 'PLAYING' && this.playSeconds - this.lastPeriodicPlaySeconds >= this.periodicSeconds) {
      this.periodicIdx += 1;
      const playSec = Math.round(this.playSeconds);
      const filename = `${this.prefix}-periodic-${String(this.periodicIdx).padStart(2, '0')}-${playSec}s-${state}.png`;
      await this.page.screenshot({ path: path.join(this.outDir, filename) });
      this.periodicShots.push(filename);
      this.periodicShotsPlaySeconds.push(this.playSeconds);
      this.lastPeriodicPlaySeconds = this.playSeconds;
    }
    return state;
  }

  // Let `durationMs` of real wall-clock time pass, polling every `pollMs`
  // (default ~100ms per the work order) so transitions/periodic shots that
  // happen DURING the wait are still caught.
  async pollFor(durationMs) {
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      await this.poll();
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollMs, remaining));
    }
    await this.poll();
  }

  durationMs() {
    return Date.now() - this.startTime;
  }
}

module.exports = { CaptureSession, sleep, FIXED_DT };
