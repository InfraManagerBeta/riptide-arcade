// Deterministic, seedable PRNG used ONLY on the Node side of the playtest
// harness (choosing exploratory actions / intervals). This is a distinct
// instance from the page's own mulberry32 RNG (window.__test.seed reseeds
// the PAGE's generator) — the two never share state, they just happen to
// use the same well-known small algorithm.
'use strict';

function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// createRng(seed) -> { next(): [0,1), int(min,maxInclusive): integer, pick(items, weights): item }
function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int(min, maxInclusive) {
      return min + Math.floor(next() * (maxInclusive - min + 1));
    },
    // weighted pick — items[i] chosen with probability weights[i] / sum(weights)
    pick(items, weights) {
      const total = weights.reduce((a, b) => a + b, 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
}

module.exports = { createRng, mulberry32 };
