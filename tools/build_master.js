#!/usr/bin/env node
/* =========================================================================
   build_master.js -- HockeyFile / TopShelf: rebuilds master.json from the raw
   JSON sources in this repo (replaces the spreadsheet Master tab).

   Usage:  node tools/build_master.js [--repo dir] [--out master_candidate.json]
             [--sources master_sources.json] [--diff master_diff.json] [--picks tools/master_picks.json]

   Picking: for each field, tools/master_picks.json lists sources in priority order. The first source with a
   valid value wins (newest row within a source). Every pick is recorded in the sidecar (--sources):
       { "<personkey>": { "<Field>": { "src": "ndc", "alts": [["tourn","2028"], ...] } } }
   `alts` lists values other sources offered that DIFFER from the pick -- the audit trail.
   Writes a candidate only; master.json is never touched (promote by copying master_candidate.json over it). --diff compares against master_last_hockeyfile.json (the final spreadsheet-era master).
   Still to build: Team, Regionals, Fresh/Soph/Jr/Sr, Highest, Yr0-3, GradGuessed (campRank.js pass).
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), opt = { repo: path.resolve(__dirname, '..'), out: 'master_candidate.json', sources: 'master_sources.json', diff: 'master_diff.json', picks: 'tools/master_picks.json' };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
const R = f => path.resolve(opt.repo, f), J = f => JSON.parse(fs.readFileSync(R(f), 'utf8'));
const RC = require(R('tools/rosterClean.js')); RC.setNameMaps(J('firstNameMap.json'));
const picks = J(opt.picks);

/* ------------------------------ normalizers ------------------------------ */
const s = v => (v == null ? '' : String(v)).replace(/ /g, ' ').trim();
// ASCII-fold text: strip accents/diacritics (NFD), map a few non-decomposing letters. Mojibake (A-tilde style) is left for pickName to out-vote.
const fold = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u00df/g, 'ss').replace(/[\u00d8\u00f8]/g, c => c === '\u00d8' ? 'O' : 'o').replace(/[\u00c6\u00e6]/g, c => c === '\u00c6' ? 'AE' : 'ae').replace(/\u0142/g, 'l').replace(/\u0141/g, 'L').replace(/[\u2018\u2019]/g, "'");
const N = {
  pos: v => { const x = RC.normalizePos(s(v)); const t = x === 'D/F' ? 'F/D' : x; return /^(F|D|G|F\/D)$/.test(t) ? t : ''; },
  dob: v => { const m = s(v).replace(/\(.*$/, '').trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/); return m && +m[3] >= 1990 && +m[3] <= 2018 && +m[1] <= 12 && +m[2] <= 31 ? `${+m[1]}/${+m[2]}/${m[3]}` : ''; },
  byr: v => { const y = +s(v); return y >= 1990 && y <= 2018 ? y : ''; },
  grad: v => { const m = s(v).match(/^(20\d{2})/); const y = m ? +m[1] : 0; return y >= 2015 && y <= 2035 ? y : ''; },
  ht: v => { const h = RC.normHeight(s(v).replace(/^(\d)\s*"\s*(\d{1,2})$/, "$1'$2\"")).value; const m = h.match(/^(\d)-(\d{1,2})$/); return m && +m[1] >= 4 && +m[1] <= 6 && +m[2] <= 11 ? `${m[1]}'${m[2]}"` : ''; },
  wt: v => { const w = Math.round(+s(v)); return w >= 80 && w <= 250 ? w : ''; },
  gpa: v => { const g = +s(v); return g > 0 && g <= 5 ? g : ''; },
  txt: v => fold(s(v)),
  ctry: v => { const c = s(v); return /^usa?$/i.test(c) ? 'US' : /^can(ada)?$/i.test(c) ? 'CAN' : c; },
  arrival: v => { const m = s(v).match(/^(20\d{2})/); return m ? N.grad(m[1]) : ''; },
};
// DOB precision: 'day' (M/D/YYYY), 'month' (M/YYYY, or M/0/YY), 'year' (YYYY). Anything else (#REF!, junk) -> null.
function parseDob(raw) {
  const t = s(raw).replace(/\(.*$/, '').trim(); if (!t || t[0] === '#') return null;
  let m, o = null;
  if ((m = t.match(/^(\d{4})$/))) o = { prec: 'year', y: +m[1] };
  else if ((m = t.match(/^(\d{1,2})[\/-](\d{4})$/))) o = { prec: 'month', y: +m[2], m: +m[1] };
  else if ((m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/))) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; o = +m[2] === 0 ? { prec: 'month', y, m: +m[1] } : { prec: 'day', y, m: +m[1], d: +m[2] }; }
  if (!o || o.y < 1990 || o.y > 2018 || (o.m && (o.m < 1 || o.m > 12)) || (o.d && (o.d < 1 || o.d > 31))) return null;
  return o;
}
const dobStr = o => o.prec === 'day' ? `${o.m}/${o.d}/${o.y}` : o.prec === 'month' ? `${o.m}/${o.y}` : `${o.y}`;
const PREC = { day: 3, month: 2, year: 1 };
/* ------------------------------ source tables ----------------------------- */
// Each source: rows(pk) -> array of raw rows, NEWEST FIRST; get[field] -> [rawValueFn, normalizer]
const idx = (rows, key, order) => { const m = new Map(); rows.forEach(r => { const k = typeof key === 'function' ? key(r) : r[key]; if (!k) return; (m.get(k) || m.set(k, []).get(k)).push(r); }); if (order) m.forEach(a => a.sort(order)); return m; };
const desc = f => (a, b) => (+b[f] || 0) - (+a[f] || 0);
const flatCol = () => { const c = J('colrosters.json'), out = []; Object.keys(c).sort().reverse().forEach(sea => Object.keys(c[sea]).forEach(sc => c[sea][sc].forEach(p => out.push(Object.assign({ _season: sea, _school: sc }, p))))); return out; };
const tourn = J('tourneys_all.json');                       // already newest season first
const SRC = {
  ndc:    { t: idx(J('ndc.json'), 'personkey', desc('YEAR')), name: 'NAME', yearOf: r => r.YEAR, get: { Name: ['NAME', 'txt'], Position: ['Pos', 'pos'], DOB: ['DOB', 'dob'], BirthYr: ['BIRTHYR', 'byr'], Grad: ['GRAD', 'grad'], Height: ['HT', 'ht'], Weight: ['WT', 'wt'], GPA: ['GPA', 'gpa'], City: ['HOMETOWN', 'txt'], State: ['STATE', 'txt'], Country: ['Country', 'ctry'], School: ['School-calc', 'txt'] } },
  prov:   { t: idx(J('provrosters.json'), 'personkey', desc('Year')), get: { Name: ['Name', 'txt'], Position: ['Position', 'pos'], DOB: ['DOB', 'dob'], BirthYr: ['BirthYr', 'byr'], Grad: ['Grad-EST', 'grad'], Height: ['Height', 'ht'], Weight: ['Weight', 'wt'], City: ['Home City', 'txt'], State: ['Home Province', 'txt'], Country: ['Home Country', 'ctry'] } },
  commits:{ t: idx(J('commits.json').slice().reverse(), 'personkey'), get: { Name: ['NAME', 'txt'], Position: ['POS', 'pos'], DOB: ['DOB clean', 'dob'], BirthYr: ['BirthYr', 'byr'], Grad: ['EST. ARRIVAL', 'arrival'], City: ['City-Clean', 'txt'], State: ['State/Prov', 'txt'], Country: ['Country', 'ctry'], School: ['School(clean)', 'txt'], College: ['College', 'txt'], Notable: ['NOTABLE', 'txt'] } },
  d3:     { t: idx(J('commits_d3.json').slice().reverse(), 'personkey'), get: { Name: ['NAME', 'txt'], Position: ['POS', 'pos'], DOB: ['DOB', 'dob'], BirthYr: ['BirthYr', 'byr'], Grad: ['EST. ARRIVAL', 'arrival'], State: ['State/Prov', 'txt'], College: ['College', 'txt'], Notable: ['NOTABLE', 'txt'] } },
  nepsac: { t: idx(J('nepsac.json'), 'personkey', desc('Year2')), get: { Name: ['Name', 'txt'], Position: ['Position', 'pos'], Grad: ['Grad', 'grad'], City: ['Home City', 'txt'], State: ['State/Prov', 'txt'], Country: ['Country/Region', 'ctry'], School: ['School', 'txt'] } },
  ccm:    { t: idx(J('ccm68.json'), 'personkey'), get: { Name: ['Name', 'txt'], Position: ['Pos', 'pos'], DOB: ['DOB_clean', 'dob'], BirthYr: ['BirthYr', 'byr'], Grad: ['Grad', 'grad'], City: ['Hometown', 'txt'], State: ['State', 'txt'], Country: ['Country', 'ctry'] } },
  ma:     { t: idx(J('ma.json'), 'personkey'), get: { Name: ['Name', 'txt'], Position: ['Position', 'pos'], BirthYr: ['BirthYr', 'byr'], Grad: ['Grad', 'grad'], State: ['State', 'txt'], Country: ['Country', 'ctry'] } },
  tourn:  { t: idx(tourn, 'pk'), get: { Name: ['name', 'txt'], Position: ['rp', 'pos'], DOB: ['dob', 'dob'], BirthYr: ['ry', 'byr'], Grad: ['rg', 'grad'], Height: ['ht', 'ht'], City: ['home', 'txt'], State: ['state', 'txt'], Country: ['country', 'ctry'], School: ['school', 'txt'] } },
  colrosters: { t: idx(flatCol(), 'pk'), get: { Name: ['name', 'txt'], Position: ['pos', 'pos'], Height: ['ht', 'ht'], City: ['home', 'txt'], State: ['st', 'txt'], Country: ['ctry', 'ctry'], College: ['_school', 'txt'] } },
};
// EliteProspects: gap-filler only. Match on personkey + year_of_birth together (see EP_NOTES.md): with a known birth year from other sources,
// only an EP row with that year counts; with none known, EP counts only when every EP row for the key agrees on one year.
const EP = idx(J('ep.json').filter(r => /^female$/i.test(r.gender || 'female')), 'personkey', (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
// legacy: the final spreadsheet-era master (master_last_hockeyfile.json), used ONLY as a stopgap for College (D3 college names not yet in commits_d3.json, and original commit schools of transfers).
SRC.legacy = { t: idx(J('master_last_hockeyfile.json'), 'PersonKey'), get: { College: ['College', 'txt'] } };
SRC.ep = { t: EP, get: { Position: ['position', 'pos'], DOB: ['date_of_birth', 'dob'], BirthYr: ['year_of_birth', 'byr'], Height: ['height_imperial', 'ht'], Weight: ['weight_lbs', 'wt'] } };
let CUR_BY = '';                      // best birth year known from non-EP sources for the player being built
function epRows(pk) {
  const rs = EP.get(pk) || []; if (!rs.length) return [];
  if (CUR_BY) return rs.filter(r => +r.year_of_birth === +CUR_BY);
  const yrs = new Set(rs.map(r => r.year_of_birth)); return yrs.size === 1 ? rs : [];
}
const overrides = new Map(); J('overrides.json').overrides.forEach(o => (overrides.get(o.personkey) || overrides.set(o.personkey, []).get(o.personkey)).push(o));
const FIELD_NORM = { Name: 'txt', Position: 'pos', DOB: 'dob', BirthYr: 'byr', Grad: 'grad', Height: 'ht', Weight: 'wt', GPA: 'gpa', City: 'txt', State: 'txt', Country: 'ctry', School: 'txt', College: 'txt', Notable: 'txt' };

// first valid value a source offers for a field (newest row first)
function offer(src, pk, field) {
  if (src === 'override') { const o = (overrides.get(pk) || []).find(x => x.field === field); return o ? { v: o.value, forced: true } : null; }
  const S = SRC[src], g = S && S.get[field]; if (!g) return null;
  for (const r of (src === 'ep' ? epRows(pk) : S.t.get(pk) || [])) { const v = N[g[1]](r[g[0]]); if (v !== '') return { v }; }
  return null;
}
// Grad: NDC (player-entered) wins by default. A tournament/roster grad year overrides it only when it is from a season starting AFTER the newest NDC
// camp year, differs, and fits the birth year (Grad - BirthYr in 17..19) -- i.e. a probable reclass. The overruled NDC value goes into alts, flagged in note.
function pickGrad(pk) {
  const w = pickField(pk, 'Grad'); if (!w || w.src !== 'ndc') return w;
  const nr = (SRC.ndc.t.get(pk) || []).find(r => N.grad(r.GRAD) !== ''); const tr = (SRC.tourn.t.get(pk) || []).find(r => N.grad(r.rg) !== '');
  if (!nr || !tr) return w;
  const tg = N.grad(tr.rg), tsea = parseInt(String(tr.season).slice(0, 4), 10), by = +CUR_BY;
  if (String(tg) === String(w.v) || !(tsea > +nr.YEAR) || !by || !(tg - by >= 17 && tg - by <= 19)) return w;
  const alts = [['ndc', w.v]].concat((w.alts || []).filter(a => String(a[1]) !== String(tg)));
  return { v: tg, src: 'tourn', alts, note: 'newer than NDC (season ' + tr.season + ' vs NDC ' + nr.YEAR + ')' };
}
function pickField(pk, field, skip) {
  let win = null; const alts = [];
  for (const src of picks.fields[field]) { if (src === skip) continue;
    const o = offer(src, pk, field); if (!o) continue;
    if (!win) { win = { v: o.v, src }; if (o.forced && o.v === '') return { v: '', src }; }
    else if (String(o.v) !== String(win.v)) alts.push([src, o.v]);
  }
  return win ? Object.assign(win, alts.length ? { alts } : {}) : null;
}

// DOB: weighted vote. Every parseable DOB from every source row becomes a candidate "claim" (a day, month or year). Each source (once)
// supports a claim: exact match = +weight, same-fact-at-another-precision = +0.5*weight, contradiction = -0.5*weight. Weights are picks.dobTrust
// (NDC heavily, then ProvRosters/CCM, then commits, tourneys, EP...). The best score wins; then the winner is refined to the most precise
// consistent claim (a month-only winner becomes a full date if a source gives a consistent day). Day-1 dates from picks.dobDay1Suspect
// source-years count as month-only. A dead heat between conflicting claims falls back to what they share (month or year) and is flagged.
// Per-player overrides (overrides.json: DOB = full date, DOBPartial = partial with DOB blank) beat all of this.
const consDob = (a, b) => a.y === b.y && (!a.m || !b.m || a.m === b.m) && (!(a.d && b.d) || a.d === b.d);
function pickDob(pk) {
  const ov = (overrides.get(pk) || []).find(x => x.field === 'DOB' || x.field === 'DOBPartial');
  if (ov) { const o = parseDob(ov.value); if (o) return { best: o, str: dobStr(o), alts: [], conflict: false, forced: ov.field, src: 'override', note: ov.notes }; }
  const cands = [], trust = picks.dobTrust || {};
  picks.fields.DOB.forEach((src, si) => {
    const g = SRC[src].get.DOB, rows = src === 'ep' ? epRows(pk) : SRC[src].t.get(pk) || [];
    rows.forEach((r, ri) => {
      let p = parseDob(r[g[0]]); if (!p) return; let sus = false;
      const yo = SRC[src].yearOf && SRC[src].yearOf(r);
      if (p.prec === 'day' && p.d === 1 && ((picks.dobDay1Suspect || {})[src] || []).includes(+yo)) { p = { prec: 'month', y: p.y, m: p.m }; sus = true; }
      cands.push(Object.assign(p, { src, si, ri, sus }));
    });
  });
  if (!cands.length) return null;
  const bySrc = new Map(); cands.forEach(c => (bySrc.get(c.src) || bySrc.set(c.src, []).get(c.src)).push(c));
  const claims = new Map(); cands.forEach(c => { const k = dobStr(c); if (!claims.has(k)) claims.set(k, Object.assign({}, c, { k, score: 0 })); });
  const rel = (list, cl) => list.some(x => dobStr(x) === cl.k) ? 'exact' : list.some(x => consDob(x, cl)) ? 'cons' : 'contra';
  claims.forEach(cl => bySrc.forEach((list, src) => { const w = trust[src] == null ? 1 : trust[src], r = rel(list, cl); cl.score += r === 'exact' ? w : r === 'cons' ? 0.5 * w : -0.5 * w; }));
  if (CUR_BY) claims.forEach(cl => { if (cl.y !== +CUR_BY) cl.score -= 2; });   // a DOB whose year contradicts the known birth year is probably a typo
  const order = [...claims.values()].sort((a, b) => b.score - a.score || PREC[b.prec] - PREC[a.prec] || a.si - b.si || a.ri - b.ri);
  let win = order[0], ambiguous = false;
  if (order[1] && Math.abs(order[1].score - win.score) < 1e-9 && !consDob(order[1], win)) {                 // dead heat between conflicting claims
    ambiguous = true; const o = order[1];
    win = o.y === win.y ? (o.m && win.m && o.m === win.m ? { prec: 'month', y: win.y, m: win.m, k: dobStr({ prec: 'month', y: win.y, m: win.m }), src: win.src, si: win.si, ri: win.ri } : { prec: 'year', y: win.y, k: String(win.y), src: win.src, si: win.si, ri: win.ri }) : null;
    if (!win) return { best: null, conflict: true, ambiguous: true, alts: order.map(c => [c.src, c.k]), str: '' };
  } else {
    const refine = order.filter(c => c !== win && PREC[c.prec] > PREC[win.prec] && consDob(c, win)).sort((a, b) => b.score - a.score)[0];
    if (refine) win = refine;
  }
  const alts = []; let conflict = ambiguous;
  bySrc.forEach((list, src) => { const r = rel(list, win); if (r === 'exact') return; if (r === 'contra') conflict = true;
    list.forEach(c => { const t = dobStr(c) + (c.sus ? ' (day 1 = placeholder?)' : ''); if (!alts.some(x => x[0] === src && x[1] === t)) alts.push([src, t]); }); });
  const winSrcs = [...bySrc.entries()].filter(([, l]) => rel(l, win) === 'exact').map(([s2]) => s2);
  const srcName = winSrcs.length ? winSrcs.sort((x, y) => (trust[y] || 1) - (trust[x] || 1))[0] : win.src;
  return { best: Object.assign({}, win, { src: srcName }), str: dobStr(win), alts, conflict, ambiguous, supporters: winSrcs };
}

// Name: collect every spelling any listed source offers, reject junk (digits, symbols, mojibake), then score: spelling whose first name matches the
// personkey's canonical first name (Lillian over Lily), proper case (not ALL CAPS / all lower), accents kept, internal capitals (McLay over Mclay),
// number of sources agreeing; ties go to the picks.fields.Name priority order.
const strip = x => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
function pickName(pk) {
  const [lk, fk] = pk.split('|'), seen = new Map();
  picks.fields.Name.forEach((src, si) => { const g = SRC[src] && SRC[src].get.Name; if (!g) return;
    for (const r of (SRC[src].t.get(pk) || [])) { const v = N.txt(r[g[0]]); if (!v) continue; const e = seen.get(v) || seen.set(v, { v, srcs: [], si }).get(v); if (/[\u00c3\u00e3\u00c2\ufffd]/.test(String(r[g[0]]))) e.moji = true; if (!e.srcs.includes(src)) e.srcs.push(src); e.si = Math.min(e.si, si); } });
  const cands = [...seen.values()]; if (!cands.length) return null;
  cands.forEach(c => { const v = c.v, letters = v.replace(/[^\p{L}]/gu, ''); let sc = 0; if (c.moji) sc -= 100;
    if (/[0-9:;@#$%&*_=+<>\/\\|!?()\[\]{}]|[ÃÂã�]/.test(v) || /\p{L}[\u0080-¿]/u.test(v)) sc -= 100;
    if (letters.length > 3 && letters === letters.toUpperCase()) sc -= 3; if (letters.length > 3 && letters === letters.toLowerCase()) sc -= 3;
    const toks = v.split(/\s+/); if (toks.some(t => /^\p{Ll}/u.test(t) && !/^(de|di|da|van|von|la|le|st\.?)$/i.test(t))) sc -= 2;
    const sv = strip(v); if (fk && sv.startsWith(fk)) sc += 4; if (lk && sv.endsWith(lk)) sc += 2;
    sc += Math.min(2, (v.match(/\p{Ll}\p{Lu}/gu) || []).length) * 0.5;
    if (/\p{L}'\p{L}/u.test(v)) sc += 0.6;
    sc += 0.3 * (c.srcs.length - 1); c.sc = sc; });
  cands.sort((a, b) => b.sc - a.sc || a.si - b.si);
  const w = cands[0]; const alts = cands.slice(1).filter(c => c.v !== w.v).map(c => [c.srcs[0], c.v]);
  return { v: w.v, src: w.srcs.sort((a, b) => picks.fields.Name.indexOf(a) - picks.fields.Name.indexOf(b))[0], alts, junk: w.sc < -50 };
}

// Position: weighted vote across all sources (picks.posTrust). F/D is its own claim; it also gives half-weight to F and to D, and F/D therefore only wins when a source says it (or the half-weights outvote). Ties go to the newest evidence (season/year of the row), then to picks.fields.Position order.
const rowYear = (src, r) => +String(src === 'tourn' ? r.season : src === 'ndc' ? r.YEAR : src === 'prov' ? r.Year : src === 'nepsac' ? r.Year2 : src === 'ep' ? r.updated_at : '').slice(0, 4) || 0;
function pickPos(pk) {
  { const ov = (overrides.get(pk) || []).find(x => x.field === 'Position'); if (ov) { const v = N.pos(ov.value); if (v) return { v, src: 'override', alts: [] }; } }
  const trust = picks.posTrust || {}, score = {}, from = {}, yr = {}; let any = false;
  const add = (v, w, src, y) => { score[v] = (score[v] || 0) + w; if (w > 0) { (from[v] = from[v] || new Set()).add(src); yr[v] = Math.max(yr[v] || 0, y); } };
  picks.fields.Position.forEach(src => { const g = SRC[src] && SRC[src].get.Position; if (!g) return; const w = trust[src] || 1;
    const rows = src === 'ep' ? epRows(pk) : SRC[src].t.get(pk) || []; let r = null, v = '';
    for (const x of rows) { v = N.pos(x[g[0]]); if (v) { r = x; break; } } if (!v) return; any = true; const y = rowYear(src, r);
    add(v, w, src, y); if (v === 'F/D') { add('F', w / 2, src, y); add('D', w / 2, src, y); } });
  if (!any) return null;
  const order = Object.keys(score).sort((a, b) => score[b] - score[a] || (yr[b] || 0) - (yr[a] || 0));
  const win = order[0], srcs = [...from[win]].sort((a, b) => picks.fields.Position.indexOf(a) - picks.fields.Position.indexOf(b));
  const alts = []; picks.fields.Position.forEach(src => { const o = offer(src, pk, 'Position'); if (o && o.v !== win) alts.push([src, o.v]); });
  const r = { v: win, src: srcs[0], alts }; if (srcs.length > 1) r.agree = srcs; if (alts.length) r.conflict = true; return r;
}

// State / Country standardisation. State = USPS code (US), 2-letter province code (CAN) or IOC 3-letter code (anyone else); Country = US | CAN | Intl.
// Country is derived from State when State is a US state or Canadian province; the sources' own Country is only a fallback (tourneys' country is
// the team's, not the player's home, so it is last in picks.fields.Country).
const US_ST = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const PROV = { ON: 'ON', ONT: 'ON', BC: 'BC', BCO: 'BC', QC: 'QC', QUE: 'QC', AB: 'AB', ALB: 'AB', MB: 'MB', MAN: 'MB', SK: 'SK', SAS: 'SK', NS: 'NS', NSC: 'NS', NB: 'NB', NBR: 'NB', NL: 'NL', NFL: 'NL', PE: 'PE', PEI: 'PE', NT: 'NT', YT: 'YT', NU: 'NU' };
const IOC = { JAPAN: 'JPN', JPN: 'JPN', SLOVAKIA: 'SVK', SVK: 'SVK', 'SOUTH KOREA': 'KOR', KOREA: 'KOR', KOR: 'KOR', AUSTRIA: 'AUT', AUT: 'AUT', FRANCE: 'FRA', FRA: 'FRA', NORWAY: 'NOR', NOR: 'NOR', 'CZECH REPUBLIC': 'CZE', CZE: 'CZE', LITHUANIA: 'LTU', LTU: 'LTU', 'BOSNIA AND HERZEGOVINA': 'BIH', BIH: 'BIH', THAILAND: 'THA', THA: 'THA', HUNGARY: 'HUN', HUN: 'HUN', 'GREAT BRITAIN': 'GBR', GBR: 'GBR', RUSSIA: 'RUS', RUS: 'RUS', FINLAND: 'FIN', FIN: 'FIN', NETHERLANDS: 'NED', NED: 'NED', CHINA: 'CHN', CHN: 'CHN', GERMANY: 'GER', GER: 'GER', SWITZERLAND: 'SUI', SUI: 'SUI', DENMARK: 'DEN', DEN: 'DEN', SPAIN: 'ESP', ESP: 'ESP', SWEDEN: 'SWE', SWE: 'SWE', ITALY: 'ITA', ITA: 'ITA', 'HONG KONG': 'HKG', HKG: 'HKG' };
function stdLoc(row, sd) {
  const raw = String(row.State || '').trim(), u = raw.toUpperCase();
  let st = '', ct = '';
  if (US_ST.has(u)) { st = u; ct = 'US'; } else if (PROV[u]) { st = PROV[u]; ct = 'CAN'; } else if (IOC[u]) { st = IOC[u]; ct = 'Intl'; } else if (raw) st = raw;
  if (st !== raw) { if (st) row.State = st; else delete row.State; }
  if (!ct) { const c = String(row.Country || '').trim(), cu = c.toUpperCase(); ct = c ? (cu === 'US' ? 'US' : cu === 'CAN' ? 'CAN' : 'Intl') : ''; if (c && ct !== c && sd.Country) sd.Country.raw = c;
    if (ct) sd.Country = Object.assign(sd.Country || { src: 'unknown' }, {}); return setCtry(row, sd, ct, false); }
  return setCtry(row, sd, ct, true);
}
function setCtry(row, sd, ct, fromState) {
  const prev = row.Country; if (!ct) { delete row.Country; return; }
  row.Country = ct;
  if (fromState && prev !== ct) { const old = sd.Country; sd.Country = { src: 'state', from: sd.State && sd.State.src }; if (prev) sd.Country.alts = [[old && old.src || '?', prev]]; }
  else if (fromState && sd.Country === undefined) sd.Country = { src: 'state', from: sd.State && sd.State.src };
}

// Team2024/25/26: from rosters (tourneys_all.json is the same data, flat). One label per player per season. A player can appear on 2+ teams in a
// season; the team with the LATEST tournament wins (tools/import_tourneys.js RECENCY: Pittsburgh < MNRosters < Stoney < NIT < Misc, "later wins any
// conflict"), then the team with more tournaments, then the older age group, then label order.
const RECENCY = ['Pittsburgh', 'MNRosters', 'Stoney', 'NIT', 'Misc'];
const lvlNum = l => { const m = String(l || '').match(/(\d+)/); return m ? +m[1] : 0; };
function pickTeam(pk, y) {
  const rs = (SRC.tourn.t.get(pk) || []).filter(x => x.season.startsWith(String(y))); if (!rs.length) return null;
  const rec = r => Math.max(-1, ...(r.t || []).map(t => RECENCY.indexOf(t)));
  const sorted = rs.slice().sort((a, b) => rec(b) - rec(a) || (b.t || []).length - (a.t || []).length || lvlNum(b.lvl) - lvlNum(a.lvl) || String(b.team).localeCompare(String(a.team)));
  const w = sorted[0], alts = sorted.slice(1).map(r => r.team).filter(t => t !== w.team);
  return { v: w.team, alts: [...new Set(alts)] };
}

// Camp columns, all from tools/campRank.js (replaces the sheet's PeakCamp/ByYear).
//   Fresh/Soph/Jr/Sr = peak camp label in Grad-4 .. Grad-1; "x" once that year is past age 17 (year > BirthYr+17).
//   Yr0..Yr3         = camp flow string (e.g. "ONcamp->TmON-R->U18-C") in the years the player is 14..17 (BirthYr+14 .. BirthYr+17).
//   Highest          = all-time peak label.  GradGuessed = "Yes" when Grad is blank but Yr0..Yr3 were still computed (from BirthYr).
// International WNT-O player-years: Commits only flags the player, so the years come from the 4-digit years in NOTABLE (e.g. "U18 2024,2025,2026 (3X)");
// with none there, the year the commit was announced (Date Added). intl_wnt_o.json holds optional hand-added extra keys ("personkey|year").
const CR = require(R('tools/campRank.js'));
const INTL = fs.existsSync(R('intl_wnt_o.json')) ? J('intl_wnt_o.json') : { keys: [], players: [] };
const intlPlayers = new Set(INTL.players || []), intlKeys = new Set(INTL.keys || []);
J('commits.json').forEach(r => { if (r['WNT-O'] !== 'WNT-O' || !r.personkey) return; intlPlayers.add(r.personkey);
  let ys = [...new Set((String(r.NOTABLE || '').match(/\b20[12]\d\b/g) || []))];
  if (!ys.length) { const m = String(r['Date Added_clean'] || r['Date Added'] || '').match(/(20\d\d)\s*$/); if (m) ys = [m[1]]; }
  ys.forEach(y => intlKeys.add(r.personkey + '|' + y)); });
const PEAK = CR.buildPeakTable(J('ndc.json'), J('provrosters.json'), [...intlKeys]), OVERALL = CR.buildOverallPeakByPlayer(PEAK);
function campCols(pk, row, sd) {
  const grad = +row.Grad, by = +row.BirthYr, sdc = { src: 'campRank' };
  if (grad) ['Fresh', 'Soph', 'Jr', 'Sr'].forEach((f, i) => { const y = grad - 4 + i; let v = ''; if (by && y > by + 17) v = 'x'; else { const e = PEAK.get(pk + '|' + y); if (e) v = e.label; } if (v) { row[f] = v; sd[f] = sdc; } });
  let any = false;
  if (by) for (let i = 0; i < 4; i++) { const e = PEAK.get(pk + '|' + (by + 14 + i)); if (e && e.detail) { row['Yr' + i] = e.detail; sd['Yr' + i] = sdc; any = true; } }
  const o = OVERALL.get(pk); let hi = o ? o.label : ''; if (intlPlayers.has(pk) && (!o || o.rank < 4)) hi = 'WNT-O';
  if (hi) { row.Highest = hi; sd.Highest = sdc; }
  if (!grad && any) { row.GradGuessed = 'Yes'; sd.GradGuessed = sdc; }
}

// Team (the single club label, no age level): Commits Club(clean) (hand-checked) -> NDC TEAM -> ProvRosters Team, each cleaned to the Type-table
// friendly club name the same way import_tourneys.js does it. NEPSAC is a school, not a club, and tourneys already feed Team2024/25/26.
const IT = require(R('tools/import_tourneys.js')), matchClub = IT.typeMatcher(J('type_aliases.json'));
const clubOf = n => { const t = IT.stripTags(String(n || '')); if (!t) return ''; const h = matchClub(t); return h ? h.friendly : t; };
function pickTeamClub(pk) {
  for (const [src, get] of [['commits', r => r['Club(clean)']], ['ndc', r => clubOf(r.TEAM)], ['prov', r => clubOf(r.Team)]]) {
    for (const r of SRC[src].t.get(pk) || []) { const v = N.txt(get(r)); if (v) return { v, src }; } }
  return null;
}
/* --------------------------------- build ---------------------------------- */
const keys = new Set(); picks.universe.forEach(u => SRC[u].t.forEach((_, k) => keys.add(k)));
(picks.dropKeys || []).forEach(k => keys.delete(k));
const ORDER = ['Name', 'PersonKey', 'BirthYr', 'DOB', 'DOBPartial', 'Grad', 'Position', 'Height', 'Weight', 'GPA', 'City', 'State', 'Country', 'School', 'Team2024', 'Team2025', 'Team2026', 'Team', 'College', 'CCM68', 'Regionals', 'Fresh', 'Soph', 'Jr', 'Sr', 'Highest', 'Yr0', 'Yr1', 'Yr2', 'Yr3', 'GradGuessed', 'Notable'];
const REGIONALS = new Set(J('regionals.json').map(r => r.personkey));   // regionals.json = flat list from the sheet's Regionals tab (first 4 cols: Name, State, BirthYr, personkey)
const ccmKeys = SRC.ccm.t, out = [], side = {};
[...keys].sort().forEach(pk => {
  const row = { PersonKey: pk }, sd = {};
  CUR_BY = ''; { const by = pickField(pk, 'BirthYr', 'ep'); CUR_BY = by ? by.v : ''; }
  for (const f of Object.keys(picks.fields)) { if (f === 'DOB') continue; const p = f === 'Name' ? pickName(pk) : f === 'Position' ? pickPos(pk) : f === 'Grad' ? pickGrad(pk) : pickField(pk, f); if (p && p.v !== '') { row[f] = p.v; sd[f] = { src: p.src }; if (p.alts) sd[f].alts = p.alts; if (p.agree) sd[f].agree = p.agree; if (p.note) sd[f].note = p.note; if (p.conflict) sd[f].conflict = true; } else if (p && p.src === 'override') sd[f] = { src: 'override', blank: true }; }
  stdLoc(row, sd);
  { const d = pickDob(pk);
    if (d && d.best) { const k = d.forced ? (d.forced === 'DOB' && d.best.prec === 'day' ? 'DOB' : 'DOBPartial') : (d.best.prec === 'day' ? 'DOB' : 'DOBPartial'); row[k] = d.str; sd[k] = { src: d.src || d.best.src, prec: d.best.prec }; if (d.best.sus) sd[k].suspect = true; if (d.supporters && d.supporters.length > 1) sd[k].agree = d.supporters; if (d.note) sd[k].note = d.note; if (d.alts && d.alts.length) sd[k].alts = d.alts; if (d.conflict) sd[k].conflict = true; if (d.ambiguous) sd[k].ambiguous = true;
      if (!row.BirthYr && !d.forced) { row.BirthYr = d.best.y; sd.BirthYr = { src: 'dob-year', from: k }; }
      if (row.BirthYr && +row.BirthYr !== d.best.y) { sd[k].conflict = true; sd[k].birthYrMismatch = row.BirthYr; } }
    else if (d && d.ambiguous) sd.DOB = { src: 'none', ambiguous: true, alts: d.alts, conflict: true }; }
  // Team2024/25/26 = the club-season team label from tourneys, season starting that year
  campCols(pk, row, sd);
  { const t = pickTeamClub(pk); if (t) { row.Team = t.v; sd.Team = { src: t.src }; } }
  [2024, 2025, 2026].forEach(y => { const t = pickTeam(pk, y); if (t) { row['Team' + y] = t.v; sd['Team' + y] = { src: 'rosters' }; if (t.alts.length) sd['Team' + y].alts = t.alts.map(a => ['rosters', a]); } });
  if (ccmKeys.has(pk)) { row.CCM68 = 'Yes'; sd.CCM68 = { src: 'ccm' }; }
  if (REGIONALS.has(pk)) { row.Regionals = 'Yes'; sd.Regionals = { src: 'regionals' }; }
  // Generic per-player overrides (overrides.json) for any other field (Name, Height, Weight, GPA, City, State, Country, School, Team*, Notable, camp columns...).
  // Grad, BirthYr, Position, College, DOB and DOBPartial are handled where they are picked. value '' forces the field blank.
  const OV_SPECIAL = new Set(['Grad', 'BirthYr', 'Position', 'College', 'DOB', 'DOBPartial', 'PersonKey']);
  (overrides.get(pk) || []).forEach(ov => { if (OV_SPECIAL.has(ov.field) || !ORDER.includes(ov.field)) return;
    if (ov.value === '' || ov.value == null) { delete row[ov.field]; sd[ov.field] = { src: 'override', blank: true }; }
    else { const prev = row[ov.field]; row[ov.field] = ov.value; sd[ov.field] = { src: 'override' }; if (prev !== undefined && String(prev) !== String(ov.value)) sd[ov.field].alts = [['picked', prev]]; if (ov.notes) sd[ov.field].note = ov.notes; } });
  const o = {}; ORDER.forEach(k => { if (row[k] !== undefined) o[k] = row[k]; }); out.push(o); side[pk] = sd;
});
fs.writeFileSync(R(opt.out), JSON.stringify(out)); fs.writeFileSync(R(opt.sources), JSON.stringify(side));
console.log(`candidate: ${out.length} players -> ${opt.out}; sidecar -> ${opt.sources}`);

/* ----------------------- diff vs master.json (+ calibration) ----------------------- */
if (fs.existsSync(R('master_last_hockeyfile.json'))) {
  const M = new Map(J('master_last_hockeyfile.json').map(r => [r.PersonKey, r])), C = new Map(out.map(r => [r.PersonKey, r]));
  const canon = (f, v) => v === undefined || v === null || v === '' ? '' : f === 'Height' ? N.ht(v) : f === 'Country' ? N.ctry(v) : String(v).trim().toLowerCase();
  const rep = { players: { inBoth: [...M.keys()].filter(k => C.has(k)).length, onlyMaster: [...M.keys()].filter(k => !C.has(k)).length, onlyCandidate: [...C.keys()].filter(k => !M.has(k)).length }, fields: {}, calibration: {} };
  console.log('players:', JSON.stringify(rep.players));
  const rep2 = (f, st) => { rep.fields[f] = st; console.log(f.padEnd(11), String(st.same).padStart(6), String(st.differ).padStart(7), String(st.masterOnly).padStart(14), String(st.candOnly).padStart(22), `   [DOB extras: candidate refines master partial ${st.refinedByCand}, master has day / cand only partial ${st.masterDayCandPartial}, partials agree ${st.partialSame}]`); };
  console.log('\nfield        same   differ  master-only(cand blank)  cand-only(master blank)');
  for (const f of ORDER.filter(x => x !== 'PersonKey' && x !== 'DOBPartial')) {
    const st = { same: 0, differ: 0, masterOnly: 0, candOnly: 0, samples: { differ: [], masterOnly: [], candOnly: [] } };
    if (f === 'DOB') { Object.assign(st, { refinedByCand: 0, masterDayCandPartial: 0, partialSame: 0 }); st.samples.differ = []; st.samples.masterOnly = []; st.samples.candOnly = [];
      for (const [k, mr] of M) { const cr = C.get(k); if (!cr) continue; const mp = parseDob(mr.DOB), cd = cr.DOB && parseDob(cr.DOB), cpt = cr.DOBPartial && parseDob(cr.DOBPartial); const smp = (b, o) => { if (st.samples[b].length < 12) st.samples[b].push(Object.assign({ pk: k, master: mr.DOB === undefined ? '' : mr.DOB, cand: cr.DOB || cr.DOBPartial || '' }, o || {}, { src: (side[k].DOB || side[k].DOBPartial || {}).src || '' })); };
        const consistent = (a, b) => a.y === b.y && (!a.m || !b.m || a.m === b.m);
        if (!mp && !cd && !cpt) continue;
        if (mp && cd) { if (mp.prec === 'day') { if (dobStr(mp) === dobStr(cd)) st.same++; else { st.differ++; smp('differ'); } } else if (consistent(mp, cd)) st.refinedByCand++; else { st.differ++; smp('differ', { note: 'master partial contradicts' }); } }
        else if (mp && cpt) { if (mp.prec === 'day') { if (consistent(mp, cpt)) st.masterDayCandPartial++; else { st.differ++; smp('differ', { note: 'master day vs cand partial' }); } } else if (dobStr(mp) === dobStr(cpt)) st.partialSame++; else if (consistent(mp, cpt)) st.partialSame++; else { st.differ++; smp('differ'); } }
        else if (mp) { st.masterOnly++; smp('masterOnly'); }
        else { st.candOnly++; smp('candOnly'); } }
      rep2(f, st); continue; }
    for (const [k, mr] of M) { const cr = C.get(k); if (!cr) continue; const a = canon(f, mr[f]), b = canon(f, cr[f]);
      const bucket = a === b ? (a === '' ? null : 'same') : a && b ? 'differ' : a ? 'masterOnly' : 'candOnly';
      if (!bucket) continue; st[bucket]++; if (bucket !== 'same' && st.samples[bucket].length < 12) st.samples[bucket].push({ pk: k, master: mr[f] === undefined ? '' : mr[f], cand: cr[f] === undefined ? '' : cr[f], src: (side[k][f] || {}).src || '' }); }
    rep.fields[f] = st;
    console.log(f.padEnd(11), String(st.same).padStart(6), String(st.differ).padStart(7), String(st.masterOnly).padStart(14), String(st.candOnly).padStart(22));
  }
  function _x() {}
  // calibration: for each field+source, how often does master's value equal that source's own (newest) value?
  for (const f of Object.keys(picks.fields)) { rep.calibration[f] = {};
    for (const src of Object.keys(SRC)) { if (!SRC[src].get[f]) continue; let both = 0, eq = 0;
      for (const [k, mr] of M) { if (mr[f] === undefined || mr[f] === '') continue; CUR_BY = (C.get(k) || {}).BirthYr || ''; const o = offer(src, k, f); if (!o) continue; both++; if (canon(f, o.v) === canon(f, mr[f])) eq++; }
      rep.calibration[f][src] = { both, equal: eq, pct: both ? Math.round(1000 * eq / both) / 10 : null }; } }
  fs.writeFileSync(R(opt.diff), JSON.stringify(rep, null, 1));
  console.log('\ncalibration (master value == this source\'s value, % of players where both exist) -> see', opt.diff);
  for (const f of Object.keys(rep.calibration)) console.log(f.padEnd(9), Object.entries(rep.calibration[f]).map(([s2, c]) => `${s2} ${c.pct}% (${c.equal}/${c.both})`).join(' | '));
}
