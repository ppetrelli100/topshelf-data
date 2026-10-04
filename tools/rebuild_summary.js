#!/usr/bin/env node
/* rebuild_summary.js - compares master.json with the freshly built master_candidate.json and writes rebuild_summary.json
   (what the Master Viewer shows after a "review" rebuild). Reads rebuild_log.txt (the apply_corrections.js output) when present. */
'use strict';
const fs = require('fs'), path = require('path');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const J = f => JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8'));
const a = new Map(J('master.json').map(r => [r.PersonKey, r])), b = new Map(J('master_candidate.json').map(r => [r.PersonKey, r]));
const fieldDiffs = {}, examples = []; let changedCells = 0, changedPlayers = 0;
for (const [k, ra] of a) {
  const rb = b.get(k); if (!rb) continue; let any = false;
  for (const f of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (JSON.stringify(ra[f]) === JSON.stringify(rb[f])) continue;
    any = true; changedCells++; fieldDiffs[f] = (fieldDiffs[f] || 0) + 1;
    if (examples.length < 120) examples.push({ pk: k, name: rb.Name || ra.Name || k, field: f, from: ra[f] === undefined ? '' : ra[f], to: rb[f] === undefined ? '' : rb[f] });
  }
  if (any) changedPlayers++;
}
const logf = path.join(repo, 'rebuild_log.txt');
const applied = fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').split('\n').filter(l => /^(APPLIED|NO MATCH|NOT EDITABLE)/.test(l)) : [];
const out = {
  generated: new Date().toISOString(), applied,
  players: { before: a.size, after: b.size },
  removed: [...a.keys()].filter(k => !b.has(k)).slice(0, 100), added: [...b.keys()].filter(k => !a.has(k)).slice(0, 100),
  changedPlayers, changedCells, fieldDiffs, examples,
};
fs.writeFileSync(path.join(repo, 'rebuild_summary.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`summary: ${a.size} -> ${b.size} players, ${changedPlayers} players / ${changedCells} cells changed, ${out.removed.length} removed, ${out.added.length} added`);
