// Builds the pre-filled report.md — the document a reviewing agent completes
// after reading the evidence. Filled where the harness knows the answer,
// TODO where a human/agent must judge. See tools/playtest/README section in
// this file's header comment in index.js for the full contract.
'use strict';

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return Number(n).toFixed(digits);
}

function fpsLine(label, fps) {
  if (!fps || fps.count === 0) return `- ${label}: no samples captured`;
  return `- ${label}: min ${fmtNum(fps.min)} · median ${fmtNum(fps.median)} · mean ${fmtNum(fps.mean)} · p5 ${fmtNum(fps.p5)} (n=${fps.count})`;
}

function screenshotList(run) {
  const lines = [];
  for (const f of run.screenshots.transitions) lines.push(`  - [${f}](./${f})`);
  for (const f of run.screenshots.periodic) lines.push(`  - [${f}](./${f})`);
  if (lines.length === 0) lines.push('  - (no screenshots captured)');
  return lines.join('\n');
}

function buildReportMd(data) {
  const { game, gameDir, generatedAt, gitCommit, harness, runs, overallErrorCount } = data;
  const probe = runs.probe;
  const explore = runs.explore;

  const probeStates = probe.skipped ? '(skipped)' : probe.statesVisited.join(' → ');
  const exploreStates = explore.statesVisited.join(' → ');

  return `# Playtest report — ${game}

> **Fun is judged by the human who merges, not by this report.** This document
> carries evidence — screenshots, numbers, confusion findings — and must
> never contain a fun score, a rating, or a recommendation to merge.

## Header

| | |
|---|---|
| Game | \`${gameDir}\` |
| Generated | ${generatedAt} |
| Repo commit | ${gitCommit || 'n/a (no git metadata available)'} |
| Harness version | ${harness.version} |
| Probe run seed | default page seed (template constant); probe is a fixed scripted input script, no seed flag applies |
| Exploratory run seed | \`${harness.seed}\` (\`--seed\` to override) |
| States visited — probe | ${probeStates} |
| States visited — exploratory | ${exploreStates} |
| Error count — probe | ${probe.skipped ? 'n/a' : probe.errors.length} |
| Error count — exploratory | ${explore.errors.length} |
| Total error count | ${overallErrorCount} |
| Screenshots — probe | ${probe.skipped ? 0 : probe.screenshots.transitions.length + probe.screenshots.periodic.length} (${probe.skipped ? 0 : probe.screenshots.transitions.length} transition + ${probe.skipped ? 0 : probe.screenshots.periodic.length} periodic) |
| Screenshots — exploratory | ${explore.screenshots.transitions.length + explore.screenshots.periodic.length} (${explore.screenshots.transitions.length} transition + ${explore.screenshots.periodic.length} periodic) |

FPS stats (from real requestAnimationFrame timestamps):
${fpsLine('probe', probe.skipped ? null : probe.fps)}
${fpsLine('exploratory', explore.fps)}

## What was played

**Probe run.** ${probe.skipped
    ? `Skipped — ${probe.reason}`
    : `Ran the scripted probe **"${probe.probeName}"** (${probe.stepCount} steps) over ${(probe.durationMs / 1000).toFixed(1)}s wall clock.`}

**Exploratory run.** Bounded seeded session — seed \`${explore.seed}\`, ${explore.steps} action decisions,
${(explore.durationMs / 1000).toFixed(1)}s wall-clock duration, decision interval ${explore.intervalMin}–${explore.intervalMax}ms
(random-ish mashing across the canonical action set: left/right/up/down/primary/pause).

## What worked

_TODO (reviewer): describe what worked in your own words. Seeded evidence below — confirm or contradict it, don't just restate it._

- States reached: probe ${probeStates || '(none)'}; exploratory ${exploreStates || '(none)'}.
- Errors captured: ${overallErrorCount === 0 ? 'none — `__test.errors` was empty in both runs.' : `${overallErrorCount} — see report.json, this is NOT a clean run.`}
- Frame rate: exploratory run median ${fmtNum(explore.fps.median)} fps (p5 ${fmtNum(explore.fps.p5)} fps).
- TODO: does the game feel responsive? Does the signature mechanic read clearly from the screenshots below?

## Confusion / clarity findings

Severity values: \`blocker\` / \`major\` / \`minor\`.

| severity | where | finding |
|---|---|---|
| minor | _(example — delete this row)_ | _(example — delete this row: e.g. "MENU screen doesn't say which key pauses")_ |
| TODO | TODO | TODO |

## Explicit non-findings

_TODO (reviewer): answer yes/no for each, based on actually looking at the screenshots/report, not assumption._

- controls discoverable without instructions: yes/no
- state of play always legible (screenshots never show an ambiguous/blank frame): yes/no
- pause/restart behaved as expected (pause froze play, restart cleared previous run state): yes/no
- no visual glitches or clipping observed across the screenshot index: yes/no

## Screenshot index

### Probe run
${probe.skipped ? '_(skipped — no screenshots)_' : screenshotList(probe)}

### Exploratory run
${screenshotList(explore)}
`;
}

module.exports = { buildReportMd };
