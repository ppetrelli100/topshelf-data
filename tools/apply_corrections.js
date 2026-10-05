#!/usr/bin/env node
/* =========================================================================
   apply_corrections.js — HockeyFile / TopShelf: applies the corrections that
   were queued from the Master Viewer (source_corrections.json) to the SOURCE
   files themselves, then (optionally) re-runs the importer and the master build.

   A correction says: in source S, for the player with personkey P, wherever
   field F currently holds value FROM, change it to TO. It is applied to every
   row of that player in that source (all tournaments, all camp years), so a
   typo is fixed everywhere at once. The file is idempotent: once a correction
   has been applied, FROM no longer exists and re-running does nothing.

   Usage:
     node tools/apply_corrections.js              apply, write the source files, print a report
     node tools/apply_corrections.js --dry-run    report only, write nothing
     node tools/apply_corrections.js --rebuild    apply, then run build_master.js (always, even with no queued corrections:
                                                  rosters.json may have been changed by the Teams tab)
     --repo <dir>                                 topshelf-data checkout (default: the folder above tools/)

   Sources it can edit: tourn (rosters.json + rosters_archive.json, every season of the player), ndc, commits, prov, ccm, nepsac, ma, colrosters.
   Not editable (re-imported from outside, or derived): ep, d3 (use commits_d3 flow), legacy, derived, override.
   JSON files are edited in place at the text level, so their formatting (indent, line endings) is untouched.
   See tools/MASTER_NOTES.md ("Source corrections").
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const repo = path.resolve(opt('repo') || path.join(__dirname, '..'));
const DRY = flag('dry-run'), REBUILD = flag('rebuild');
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// master field -> raw column(s) per source (mirrors build_master.js SRC / the viewer's MAP)
const JSON_SRC = {
  ndc:    { file: 'ndc.json', pk: 'personkey', cols: { Name: ['NAME'], Position: ['Pos', 'POSITION'], DOB: ['DOB'], BirthYr: ['BIRTHYR'], Grad: ['GRAD'], Height: ['HT'], Weight: ['WT'], GPA: ['GPA'], City: ['HOMETOWN'], State: ['STATE'], Country: ['Country'], School: ['School-calc'], Team: ['Club-calc', 'TEAM'] } },
  commits:{ file: 'commits.json', pk: 'personkey', cols: { Name: ['NAME'], Position: ['POS'], DOB: ['DOB clean', 'DOB'], BirthYr: ['BirthYr'], Grad: ['EST. ARRIVAL'], City: ['City-Clean'], State: ['State/Prov'], Country: ['Country'], School: ['School(clean)'], College: ['College'], Notable: ['NOTABLE'], Team: ['Club(clean)'] } },
  prov:   { file: 'provrosters.json', pk: 'personkey', cols: { Name: ['Name'], Position: ['Position'], DOB: ['DOB'], BirthYr: ['BirthYr'], Grad: ['Grad-EST'], Height: ['Height'], Weight: ['Weight'], City: ['Home City'], State: ['Home Province'], Country: ['Home Country'], Team: ['Team'] } },
  ccm:    { file: 'ccm68.json', pk: 'personkey', cols: { Name: ['Name'], Position: ['Pos'], DOB: ['DOB_clean', 'DOB'], BirthYr: ['BirthYr'], Grad: ['Grad'], City: ['Hometown'], State: ['State'], Country: ['Country'], Team: ['Team'] } },
  nepsac: { file: 'nepsac.json', pk: 'personkey', cols: { Name: ['Name'], Position: ['Position'], Grad: ['Grad'], City: ['Home City'], State: ['State/Prov'], Country: ['Country/Region'], School: ['School'] } },
  ma:     { file: 'ma.json', pk: 'personkey', cols: { Name: ['Name'], Position: ['Position'], BirthYr: ['BirthYr'], Grad: ['Grad'], State: ['State'], Country: ['Country'] } },
  colrosters: { file: 'colrosters.json', pk: 'pk', cols: { Name: ['name'], Position: ['pos'], Height: ['ht'], City: ['home'], State: ['st'], Country: ['ctry'] } },
};
// tourn = club/tournament rosters. They live in rosters.json (live seasons) and rosters_archive.json (frozen seasons); a season held by both is
// corrected in both so the site file and the archive never disagree. master field -> player key in those files.
const ROSTER_FILES = ['rosters.json', 'rosters_archive.json'];
const ROSTER_COLS = { Name: 'name', Position: 'rp', DOB: 'dob', BirthYr: 'ry', Grad: 'rg', Height: 'ht', City: 'home', State: 'state', Country: 'ctry', School: 'school' };

/* ---------- JSON: text-level edit of leaf objects (formatting preserved) ---------- */
function leafSpans(text) {
  const spans = [], stack = []; let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (stack.length) stack[stack.length - 1].leaf = false; stack.push({ start: i, leaf: true }); }
    else if (c === '}') { const o = stack.pop(); if (o && o.leaf) spans.push([o.start, i + 1]); }
  }
  return spans;
}
function applyJson(text, src, corrs) {
  const S = JSON_SRC[src]; const spans = leafSpans(text); const hits = new Map(); let out = text;
  for (let s = spans.length - 1; s >= 0; s--) {
    const [a, b] = spans[s]; let chunk = text.slice(a, b), row; try { row = JSON.parse(chunk); } catch (e) { continue; }
    let changed = false;
    for (const c of corrs) {
      if (row[S.pk] !== c.personkey) continue;
      for (const col of S.cols[c.field] || []) {
        if (norm(row[col]) !== norm(c.from)) continue;
        const re = new RegExp('("' + col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"');
        if (!re.test(chunk)) continue;
        chunk = chunk.replace(re, (m, k) => k + JSON.stringify(c.to)); changed = true; hits.set(c, (hits.get(c) || 0) + 1); break;
      }
    }
    if (changed) out = out.slice(0, a) + chunk + out.slice(b);
  }
  // spans were processed back to front on `text`, but `out` was edited in the same order, so offsets above stay valid
  return { text: out, hits };
}

/* ---------- rosters.json / rosters_archive.json: structured edit, exact round trip ---------- */
function applyRosters(corrs) {
  const RC = require(path.join(repo, 'tools', 'rosterClean.js'));
  try { RC.setNameMaps(JSON.parse(fs.readFileSync(path.join(repo, 'firstNameMap.json'), 'utf8'))); } catch (e) { /* name maps are optional here */ }
  const hits = new Map(), written = [], notes = [];
  for (const file of ROSTER_FILES) {
    const f = path.join(repo, file); if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8'), data = JSON.parse(text);
    const trail = /\n$/.test(text); // keep whatever the file had (the importer wrote none; some push paths add one)
    if (JSON.stringify(data, null, 2) + (trail ? '\n' : '') !== text) throw new Error(file + ' does not round-trip exactly; refusing to rewrite it');
    let changed = false;
    for (const season of Object.keys(data)) for (const t of data[season]) {
      for (let pi = 0; pi < t.players.length; pi++) {
        const p = t.players[pi];
        for (const c of corrs) {
          const key = ROSTER_COLS[c.field]; if (!key || p.pk !== c.personkey) continue;
          const cur = c.field === 'Country' ? (p.ctry || t.country) : p[key]; // Country: the player's own, else the team's (what the viewer shows)
          if (norm(cur) !== norm(c.from)) continue;
          if (c.field === 'Country') { if (norm(c.to) === norm(t.country)) delete p.ctry; else p.ctry = c.to; }
          else p[key] = c.to;
          if (c.field === 'Name') {
            // a name is the source of the personkey: rebuild it exactly as the importer does (makePersonKey, then the school-aware exception)
            const school = (t.club || '') + (/\bPrep\b/.test(t.team || '') ? ' Prep' : '');
            const npk = RC.applyPkException(RC.makePersonKey(norm(c.to)), { school, state: p.state, hometown: p.home });
            if (npk && npk !== p.pk) {
              const twin = t.players.find(q => q !== p && q.pk === npk);
              if (twin) { // the corrected name is already on this roster: merge into that row, filling blanks and uniting tournaments
                Object.keys(p).forEach(k => { if (k === 'pk' || k === 'name') return; if (k === 't') twin.t = [...new Set([...(twin.t || []), ...(p.t || [])])]; else if (twin[k] === undefined || twin[k] === '') twin[k] = p[k]; });
                t.players.splice(pi, 1); pi--; notes.push(file + ' ' + season + ' ' + t.team + ': ' + c.personkey + ' merged into the existing ' + npk);
              } else { p.pk = npk; notes.push(file + ' ' + season + ' ' + t.team + ': personkey ' + c.personkey + ' -> ' + npk); }
            }
          }
          hits.set(c, (hits.get(c) || 0) + 1); changed = true; break;
        }
      }
    }
    if (changed) { if (!DRY) fs.writeFileSync(f, JSON.stringify(data, null, 2) + (trail ? '\n' : '')); written.push(file); }
  }
  return { hits, written, notes };
}

/* ------------------------------------ main ------------------------------------ */
const cf = path.join(repo, 'source_corrections.json');
if (!fs.existsSync(cf)) { console.log('No source_corrections.json - nothing to do.'); process.exit(0); }
const all = (JSON.parse(fs.readFileSync(cf, 'utf8')).corrections || []);
const bySrc = {}; all.forEach(c => (bySrc[c.source] = bySrc[c.source] || []).push(c));
const results = []; let changedTourn = false, changedAny = false;
for (const src of Object.keys(bySrc)) {
  const corrs = bySrc[src];
  if (src === 'tourn') {
    const res = applyRosters(corrs);
    if (res.hits.size) { changedTourn = true; changedAny = true; }
    res.notes.forEach(n => console.log('NOTE ' + n));
    corrs.forEach(c => results.push([c, res.hits.get(c) || 0, ROSTER_FILES.join(' + ')]));
  } else if (JSON_SRC[src]) {
    const S = JSON_SRC[src], f = path.join(repo, S.file), bad = corrs.filter(c => !(S.cols[c.field] || []).length);
    bad.forEach(c => results.push([c, -1, S.file]));
    const ok = corrs.filter(c => !bad.includes(c));
    if (!ok.length) continue;
    const res = applyJson(fs.readFileSync(f, 'utf8'), src, ok);
    if (res.hits.size) { if (!DRY) { JSON.parse(res.text); fs.writeFileSync(f, res.text); } changedAny = true; }
    ok.forEach(c => results.push([c, res.hits.get(c) || 0, S.file]));
  } else corrs.forEach(c => results.push([c, -2, src]));
}
for (const [c, n, file] of results) {
  const what = `${c.source}/${c.field} ${c.personkey}: "${c.from}" -> "${c.to}"`;
  console.log((n > 0 ? (DRY ? 'WOULD APPLY ' : 'APPLIED     ') + `(${n} row${n === 1 ? '' : 's'}) ` : n === 0 ? 'NO MATCH     (already applied, or the source has changed) ' : n === -1 ? 'NOT EDITABLE (field has no raw column in this source) ' : 'NOT EDITABLE (source cannot be corrected here) ') + what + '  [' + file + ']');
}
if (!all.length) console.log('source_corrections.json has no corrections.');

// Applied corrections leave the queue (they move to "applied" with the date), so "queued" only ever means "still waiting".
// A correction with no matching rows stays queued: it is either already applied by hand or no longer matches, and someone should look.
if (!DRY) {
  const key = c => [c.source, c.personkey, c.field, c.from].join('\u0001');
  const done = new Set(results.filter(r => r[1] > 0).map(r => key(r[0])));
  if (done.size) {
    const j = JSON.parse(fs.readFileSync(cf, 'utf8')), today = new Date().toISOString().slice(0, 10);
    const moved = (j.corrections || []).filter(c => done.has(key(c)));
    j.corrections = (j.corrections || []).filter(c => !done.has(key(c)));
    j.applied = (j.applied || []).concat(moved.map(c => Object.assign({}, c, { applied: today })));
    const line = c => '    ' + JSON.stringify(c).replace(/":/g, '": ').replace(/,"/g, ', "');
    fs.writeFileSync(cf, '{\n  "version": ' + JSON.stringify(j.version || 1) + ',\n  "description": ' + JSON.stringify(j.description) + ',\n  "corrections": [\n' + j.corrections.map(line).join(',\n') + '\n  ]' +
      (j.applied.length ? ',\n  "applied": [\n' + j.applied.map(line).join(',\n') + '\n  ]' : '') + '\n}\n');
    console.log('Moved ' + moved.length + ' applied correction(s) out of the queue.');
  }
}
if (REBUILD && !DRY) {   // always: rosters.json can change with no queued correction (Teams tab pushes), and master reads it
  // rosters.json is the editable source now, so there is no re-import step: a corrected roster is simply what build_master reads next.
  const run = (cmd) => { console.log('\n$ ' + cmd); cp.execSync(cmd, { cwd: repo, stdio: 'inherit' }); };
  run('node tools/build_master.js');
  console.log('\nDone. master_candidate.json is rebuilt; diff it against master.json, then promote as usual.');
}
