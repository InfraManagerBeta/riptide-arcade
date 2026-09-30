// Small crypto/JSON helpers shared by report.json assembly.
'use strict';

const crypto = require('crypto');

// Canonical JSON: object keys sorted recursively, so the digest is stable
// regardless of property insertion order.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function sha256OfCanonicalJson(value) {
  const canonical = canonicalize(value);
  const json = JSON.stringify(canonical);
  return `sha256:${crypto.createHash('sha256').update(json).digest('hex')}`;
}

module.exports = { canonicalize, sha256OfCanonicalJson };
