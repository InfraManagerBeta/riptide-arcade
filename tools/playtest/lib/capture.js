// Screenshot capture manager shared by both the probe run and the
// exploratory run. Two independent triggers, per the work order:
//   1. a shot on every __test.state() TRANSITION (polled frequently);
//   2. a shot every PERIODIC_MS of wall-clock time the run is in progress,
//      regardless of state.
// Because __test.tick(n) costs no wall clock, transitions produced purely by
// tick() calls only ever fire trigger (1) — it is the real waiting
// (waitMs steps, and the exploratory session's real decision intervals)
// that lets trigger (2) actually fire. See runProbe/runExplore.
'use strict';

const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CaptureSession {
  constructor({ page, outDir, prefix, periodicMs = 5000, pollMs = 100 }) {
    this.page = page;
    this.outDir = outDir;
    this.prefix = prefix;
    this.periodicMs = periodicMs;
    this.pollMs = pollMs;

    this.lastState = null;
    this.statesVisited = [];
    this.transitionShots = [];
    this.periodicShots = [];
    this.transitionIdx = 0;
    this.periodicIdx = 0;
    this.startTime = Date.now();
    this.lastPeriodicAt = this.startTime;
  }

  async _readState() {
    return this.page.evaluate(() => (window.__test ? window.__test.state() : null));
  }

  // One immediate check: shoot on state change, shoot on periodic cadence.
  // Safe to call as often as you like — cheap no-op when nothing fired.
  async poll() {
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
    const now = Date.now();
    if (now - this.lastPeriodicAt >= this.periodicMs) {
      this.periodicIdx += 1;
      const elapsedSec = Math.round((now - this.startTime) / 1000);
      const filename = `${this.prefix}-periodic-${String(this.periodicIdx).padStart(2, '0')}-${elapsedSec}s-${state}.png`;
      await this.page.screenshot({ path: path.join(this.outDir, filename) });
      this.periodicShots.push(filename);
      this.lastPeriodicAt = now;
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

module.exports = { CaptureSession, sleep };
