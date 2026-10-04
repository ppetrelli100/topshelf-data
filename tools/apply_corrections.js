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
     node tools/apply_corrections.js --rebuild    apply, then run import_tourneys.js (when the tournament CSV
                                                  changed) and build_master.js
     --repo <dir>                                 topshelf-data checkout (default: the folder above tools/)

   Sources it can edit: tourn (archive/tourneys_2023-2026.csv), ndc, commits, prov, ccm, nepsac, ma, colrosters.
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
const TOURN = { file: 'archive/tourneys_2023-2026.csv', cols: { Name: 'Name', Position: 'Pos', DOB: 'DOB', BirthYr: 'YOB', Grad: 'Grad', Height: 'Height', City: 'Hometown', State: 'State', Country: 'Country', School: 'School' } };

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

/* ---------- CSV (tournament archive): exact round trip ---------- */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const qv = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const writeCsv = rows => rows.map(r => r.map(qv).join(',')).join('\n') + '\n';

function applyTourn(text, corrs) {
  const RC = require(path.join(repo, 'tools', 'rosterClean.js'));
  try { RC.setNameMaps(JSON.parse(fs.readFileSync(path.join(repo, 'firstNameMap.json'), 'utf8'))); } catch (e) { /* name maps are optional here */ }
  const rows = parseCsv(text), head = rows[0], hits = new Map();
  if (writeCsv(rows) !== text) throw new Error('tournament CSV does not round-trip exactly; refusing to rewrite it');
  const col = n => head.indexOf(n), iName = col('Name'), iPk = col('personkey');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (row.length < 2) continue;
    const pk0 = RC.makePersonKey(norm(row[iName]));
    for (const c of corrs) {
      const ci = col(TOURN.cols[c.field]); if (ci < 0) continue;
      if (!(pk0 === c.personkey || (iPk >= 0 && row[iPk] === c.personkey))) continue;
      if (norm(row[ci]) !== norm(c.from)) continue;
      row[ci] = c.to; hits.set(c, (hits.get(c) || 0) + 1);
    }
  }
  return { text: writeCsv(rows), hits };
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
    const f = path.join(repo, TOURN.file), res = applyTourn(fs.readFileSync(f, 'utf8'), corrs);
    if (res.hits.size && !DRY) { fs.writeFileSync(f, res.text); changedTourn = true; changedAny = true; }
    if (res.hits.size && DRY) { changedTourn = true; changedAny = true; }
    corrs.forEach(c => results.push([c, res.hits.get(c) || 0, TOURN.file]));
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
if (REBUILD && changedAny && !DRY) {
  const run = (cmd) => { console.log('\n$ ' + cmd); cp.execSync(cmd, { cwd: repo, stdio: 'inherit' }); };
  if (changedTourn) {
    run('node tools/import_tourneys.js archive/tourneys_2023-2026.csv --out rosters.json --report import_report.json --known commits.json,colrosters.json,ndc.json');
    run('node tools/import_tourneys.js archive/tourneys_2023-2026.csv --window all --out none --report ' + path.join(require('os').tmpdir(), 'ts_report_all.json') + ' --players-out tourneys_all.json --known commits.json,colrosters.json,ndc.json');
  }
  run('node tools/build_master.js');
  console.log('\nDone. master_candidate.json is rebuilt; diff it against master.json, then promote as usual.');
} else if (REBUILD && !changedAny) console.log('\nNothing changed, so nothing to rebuild.');
