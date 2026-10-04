#!/usr/bin/env node
/* =========================================================================
   import_tourneys.js — HockeyFile / TopShelf: turns raw tournament-roster
   rows (the old "Tourneys" tab layout) into rosters.json.

   Replaces the spreadsheet's Tourneys -> Rosters formula chain. See
   tools/TOURNEYS_NOTES.md for every rule and why it exists.

   Usage:
     node tools/import_tourneys.js <tourneys.csv> [options]
       --out <file>       rosters.json to write            (default: rosters.json)
       --report <file>    JSON report of flags/conflicts   (default: import_report.json)
       --repo <dir>       topshelf-data checkout           (default: the folder above tools/)
       --known <a,b,..>   extra JSON files whose personkeys feed the swapped-name check
       --window <N|all>   seasons to keep: latest N (default 3) or 'all'
       --players-out <f>  also write a flat, player-level file (one row per player per season, newest first); use with --window all
       --master <file>    master.json (PersonKey, BirthYr): birth-year fallback for play-up removal (default: master.json in the repo)

   Pure functions are exported (buildRosters, resolveTeam, ...) so the
   updates.html import tab can reuse exactly the same rules.
   ========================================================================= */
'use strict';
// Node-only modules (fs, path) are required inside main() so this file can also be loaded in a browser (updates.html Teams tab).

/* ----------------------------- configuration ----------------------------- */

// Tournament order of the OLD sheet's Roster_Class (used only to sort rows
// the same way the sheet did, so "first row" ties resolve identically).
const CLASS_ORDER = ['Stoney', 'Pittsburgh', 'MNRosters', 'NIT', 'Misc'];
// Earliest -> latest in the season. When two tournaments disagree, the
// LATER one wins (jersey #, position, and any other single-valued field).
const RECENCY = ['Pittsburgh', 'MNRosters', 'Stoney', 'NIT', 'Misc'];
const WINDOW_SEASONS = 3;                    // rolling: latest Year and the two before
// The only clubs where a #2 team is tracked (raw name ends "14-2"/"16-2"/"19-2").
const SQUAD2_CLUBS = ["East Coast Wizards", "Boston Jr Eagles", "Shattuck-St. Mary's", "Lovell Academy"];
// The only club whose top team keeps "Prep" in the displayed team name.
const PREP_LABEL_CLUBS = ["Shattuck-St. Mary's"];

const normShot = v => { const m = String(v || '').trim().match(/^(?:catch(?:es)?\s*)?(?:glove\s*)?(l|r|left|right)$/i); return m ? m[1][0].toUpperCase() : String(v || '').trim(); };
// Grad column arrives as '2027', '2027/28', '27/28', '2026-PG', 'PG', 'GAP', 'CEGEP', 'tba'... -> 4-digit year or ''.
// A dual school-year value ('2027/28', '27/28') takes the LATER year (2028); '-PG' is dropped and the number kept ('2026-PG' -> 2026);
// anything with no year at all ('PG', 'GAP', 'CEGEP', 'tba') becomes blank.
function normGrad(g) {
  const t = String(g == null ? '' : g).replace(/\u00a0/g, ' ').trim();
  let m = t.match(/^(20)(\d{2})\s*[\/-]\s*(\d{2})$/); if (m) return m[1] + m[3];
  m = t.match(/^(\d{2})\s*\/\s*(\d{2})$/); if (m) return '20' + m[2];
  m = t.match(/^(20\d{2})\s*[-\/]?\s*PG$/i); if (m) return m[1];
  m = t.match(/^(20\d{2})$/); if (m) return m[1];
  return '';
}
// Committed-school guesses for spellings that don't match the D1 list (Sept/Oct 2026). Key = lowercase, no punctuation/spaces.
// Non-D1 schools (D3, U Sports) are only unified to one spelling; they are not in d1.json.
const COMMIT_ALIASES = {
  mnstate: 'Minnesota State', mankato: 'Minnesota State', mnduluth: 'Minnesota -Duluth', bostonu: 'Boston University', bostoncollege: 'Boston College', bostonc: 'Boston College',
  brownu: 'Brown', stcloud: 'St. Cloud State', stcloudst: 'St. Cloud State', sared: 'Sacred Heart', saredheart: 'Sacred Heart', stanselms: 'Saint Anselm', franklinpearce: 'Franklin Pierce',
  franklinpeirce: 'Franklin Pierce', quinnipaic: 'Quinnipiac', liu: 'Long Island', merrimak: 'Merrimack', universityofwisconsin: 'Wisconsin', universityofvermont: 'Vermont',
  ubc: 'UBC', universityofbritishcolumbia: 'UBC', trinitywestern: 'Trinity Western', calgary: 'Calgary', universityofcalgary: 'Calgary', nippissing: 'Nipissing', nippising: 'Nipissing',
  mountroyal: 'Mount Royal', mountroyaluniversity: 'Mount Royal', toronto: 'Toronto', universityoftoronto: 'Toronto', newbrunswick: 'UNB', unb: 'UNB',
  stfrancisxavieruniversity: 'St. Francis Xavier', colbycollege: 'Colby', saintbenedictcollege: 'Saint Benedict', wakeforestsoccer: 'Wake Forest',
};
const COMMIT_JUNK = /^(t\s*#\d+|was\s*\d+)$/i;      // jersey-number notes typed into the Committed column
function normCommit(RC, raw, d1) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t || COMMIT_JUNK.test(t)) return { value: '', matched: true, junk: !!t };
  const r = RC.normCommitted(t, d1); if (r.matched) return r;
  const a = COMMIT_ALIASES[t.toLowerCase().replace(/[^a-z]/g, '')];
  if (a) { const r2 = RC.normCommitted(a, d1); return { value: r2.value, matched: true }; }
  return r;
}
const norm = s => String(s == null ? '' : s).trim();
const tourneyKey = t => { const k = norm(t).toLowerCase(); return CLASS_ORDER.find(c => c.toLowerCase() === k) || null; };

/* ------------------------------- CSV I/O -------------------------------- */

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length > 1 || r[0] !== '').map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; }); return o; });
}

/* --------------------- team / level resolution (ported) ------------------- */
// R  Strip_tags : the club name with its age-group/tier suffix removed
// S  OrgResolved: Type-table friendly name (regex match), else the stripped name
// T  LevelNorm  : 14U/16U/19U (US) or U15/U18/U22 (CAN) — convention follows the COUNTRY column
// These are line-for-line ports of the sheet formulas (verified 22,667/22,667 on R and T).

const stripTags = team => norm(team) ? norm(team).replace(/\s*U?\d{1,2}U?\s*(?:AAA|AA|A|B)?.*$/i, '').trim() : '';

function typeMatcher(typeAliases) {
  const T = typeAliases.map(t => ({ re: new RegExp(t.pattern, 'i'), friendly: t.friendly, type: t.type, country: t.country }));
  const cache = new Map();
  const prep = s => s.toUpperCase().trim()
    .replace(/HIGH[\s.\-]*SCHOOL/g, 'HS')
    .replace(/\b(?:U\s*[-/]?\s*\d{1,2}[A-Z]*|\d{1,2}\s*[-/]?\s*U[A-Z]*)\b/g, '')
    .replace(/\b(?:14|15)\b/g, '');
  return stripped => {
    if (cache.has(stripped)) return cache.get(stripped);
    const s = prep(stripped); const hit = T.find(t => t.re.test(s));
    const r = hit ? hit : null; cache.set(stripped, r); return r;
  };
}

function levelNorm(level, country) {
  const L = norm(level).toUpperCase(); if (!L) return '';
  const C = norm(country).toUpperCase();
  const tier = /^(14U|U14U?|U15|15U)(AAA|AA|A|B)?$/.test(L) ? '14' : /^(16U|U16U?|U18|18U)(AAA|AA|A|B)?$/.test(L) ? '16' : /^(19U|U19U?|U22|22U)(AAA|AA|A|B)?$/.test(L) ? '19' : L;
  if (C === 'CAN') { if (tier === '14') return 'U15'; if (tier === '16') return 'U18'; if (tier === '19') return 'U22'; }
  if (tier === '14') return '14U'; if (tier === '16') return '16U'; if (tier === '19') return '19U';
  return L;
}

/* ------------------------------ the build -------------------------------- */

function posOf(RC, p) { const x = RC.normalizePos(p); return (x === 'F/D' || x === 'F / D') ? 'F' : (x === 'D/F' || x === 'D / F') ? 'D' : x; }
const seasonLabel = y => `${y}-${String((+y + 1) % 100).padStart(2, '0')}`;

/* One raw tournament/roster row (old Tourneys-tab layout) -> one cleaned row, or null if the tournament name is not recognised.
   S = { RC, d1, known, match, canon, report }. Shared by buildRosters() and the Teams tab on updates.html, so a pasted roster is cleaned by exactly the same code. */
function cleanRow(r, idx, S) {
  const { RC, d1, known, match, canon, report } = S;
    const tk = tourneyKey(r.Tourney);
    if (!tk) { report.unknownTourneys[r.Tourney] = (report.unknownTourneys[r.Tourney] || 0) + 1; return null; }
    const stripped = stripTags(r.Team);
    const hit = match(stripped);
    const club = hit ? hit.friendly : canon(stripped);
    if (!hit && stripped) report.unmatchedOrgs[club] = (report.unmatchedOrgs[club] || 0) + 1;
    const rawTeam = norm(r.Team);
    const wantsSquad2 = /(?:14|16|19)-2\s*$/i.test(rawTeam);
    let squad = 1;
    if (wantsSquad2) { if (SQUAD2_CLUBS.includes(club)) squad = 2; else report.squadWarnings.push(`${r.Year} ${rawTeam}: looks like a #2 team but ${club} is not in SQUAD2_CLUBS`); }
    const prep = /\bprep\b/i.test(rawTeam) && PREP_LABEL_CLUBS.includes(club);
    const lvl = levelNorm(r.Level, hit && hit.country ? hit.country : r.Country);   // level labels follow the CLUB's home country (Type table), not each player's
    if (!['14U', '16U', '19U', 'U15', 'U18', 'U22'].includes(lvl)) report.badLevel[`${r.Level}|${r.Country}`] = (report.badLevel[`${r.Level}|${r.Country}`] || 0) + 1;

    const name = norm(r.Name).replace(/\s+/g, ' ');
    const pk0 = RC.makePersonKey(name);
    const hm = RC.normalizeStateAndHometown(r.State, r.Hometown);
    const pk = RC.applyPkException(pk0, { school: club + (prep ? ' Prep' : ''), state: hm.state, hometown: hm.home });
    const swap = known ? RC.computeSwapIssue(name, pk, known) : '';
    if (swap) report.swapFlags.push(`${r.Year} ${rawTeam} ${name}: ${swap}`);
    RC.checkYearSanity(r.YOB, normGrad(r.Grad)).forEach(m => report.yearFlags.push(`${r.Year} ${rawTeam} ${name}: ${m}`));
    const ht = RC.normHeight(norm(r.Height).replace(/^(\d)\s*"\s*(\d{1,2})$/, "$1'$2\"")); if (ht.issue) report.heightFlags.push(`${r.Year} ${rawTeam} ${name}: ${ht.issue}`);
    const cm = normCommit(RC, r.Committed, d1); if (cm.junk) (report.commitJunk = report.commitJunk || []).push(`${r.Year} ${rawTeam} ${name}: "${norm(r.Committed)}" dropped`); if (cm.value && !cm.matched) report.commitUnmatched[cm.value] = (report.commitUnmatched[cm.value] || 0) + 1;
    if (norm(r.NameTag)) report.tagged++;
    if (norm(r.Grad) && !/^20\d{2}$/.test(norm(r.Grad))) { const k = norm(r.Grad) + ' -> ' + (normGrad(r.Grad) || '(blank)'); report.gradNormalized = report.gradNormalized || {}; report.gradNormalized[k] = (report.gradNormalized[k] || 0) + 1; }
    return {
      idx, year: +r.Year, tk, classIdx: CLASS_ORDER.indexOf(tk), recency: RECENCY.indexOf(tk), rawTeam, club, squad, prep, lvl, rawLevel: norm(r.Level), country: norm(r.Country),
      pk, name, n: norm(r['#']), pos: posOf(RC, r.Pos), yob: norm(r.YOB), grad: normGrad(r.Grad), dob: norm(r.DOB), school: norm(r.School), shot: normShot(r.Shot),
      state: hm.state, home: hm.home, ht: ht.value, commit: cm.value, tag: norm(r.NameTag),
    };
}

function buildRosters(rawRows, ctx) {
  const { RC, typeAliases, d1, known, birthYears } = ctx;
  const windowSeasons = ctx.windowSeasons == null ? WINDOW_SEASONS : ctx.windowSeasons;
  const match = typeMatcher(typeAliases);
  const report = { unknownTourneys: {}, swapFlags: [], yearFlags: [], heightFlags: [], commitUnmatched: {}, unmatchedOrgs: {}, badLevel: {}, squadWarnings: [], conflicts: { n: 0, rg: 0, rp: 0, country: 0 }, tagged: 0 };
  const years = [...new Set(rawRows.map(r => +r.Year).filter(Boolean))].sort((a, b) => a - b);
  const maxYear = years[years.length - 1];
  const inWindow = y => +y > maxYear - windowSeasons;

  // Case-insensitive canonical spelling for names the Type table does not know:
  // most frequent spelling wins (ties: first seen), so output never depends on row order luck.
  const spell = new Map();
  rawRows.forEach(r => { const s = stripTags(r.Team); if (!s) return; const k = s.toLowerCase(); const m = spell.get(k) || new Map(); m.set(s, (m.get(s) || 0) + 1); spell.set(k, m); });
  const canon = s => { const m = spell.get(s.toLowerCase()); if (!m) return s; return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };

  // 1. clean + resolve every in-window row
  const rows = [];
  const S = { RC, d1, known, match, canon, report };
  rawRows.forEach((r, idx) => {
    if (!inWindow(r.Year)) return;
    const cr = cleanRow(r, idx, S); if (cr) rows.push(cr);
  });

  // 2. sort exactly like the sheet: Year, tournament class, raw team, tournament, position (blank last)
  const posRank = p => p === '' ? 9 : p;
  rows.sort((a, b) => a.year - b.year || a.classIdx - b.classIdx || (a.rawTeam < b.rawTeam ? -1 : a.rawTeam > b.rawTeam ? 1 : 0) ||
    (posRank(a.pos) < posRank(b.pos) ? -1 : posRank(a.pos) > posRank(b.pos) ? 1 : 0) || a.idx - b.idx);

  // 3. group into team-years, then players, then merge duplicate rows field by field
  const seasons = {};
  const teamIndex = new Map();
  rows.forEach(r => {
    const sk = seasonLabel(r.year); (seasons[sk] = seasons[sk] || []);
    const tkey = `${r.year}|${r.club}|${r.lvl}|${r.squad}`;
    let t = teamIndex.get(tkey);
    if (!t) { t = { key: tkey, season: sk, club: r.club, lvl: r.lvl, squad: r.squad, prep: false, raws: new Set(), lvls: new Set(), tourneys: new Set(), players: new Map() }; teamIndex.set(tkey, t); seasons[sk].push(t); }
    if (r.prep) t.prep = true; t.raws.add(r.rawTeam); t.lvls.add(r.rawLevel); t.tourneys.add(r.tk);
    (t.players.get(r.pk) || t.players.set(r.pk, []).get(r.pk)).push(r);
  });

  const out = {};
  for (const sk of Object.keys(seasons).sort()) {
    out[sk] = seasons[sk].map(t => {
      const players = [];
      const countryVotes = {};
      for (const [pk, rs] of t.players) {
        const byRecent = rs.slice().sort((a, b) => b.recency - a.recency || a.idx - b.idx);   // most recent tournament first
        const first = f => { for (const r of byRecent) if (r[f] !== '' && r[f] != null) return r[f]; return ''; };
        const distinct = f => [...new Set(byRecent.map(r => r[f]).filter(v => v !== ''))];
        const alt = {};
        const n = first('n'); const nAll = distinct('n'); if (nAll.length > 1) { alt.n = nAll; report.conflicts.n++; }
        const gAll = distinct('grad').map(Number).filter(Boolean).sort((a, b) => b - a);   // latest grad year wins
        const rg = gAll.length ? String(gAll[0]) : ''; if (gAll.length > 1) { alt.rg = gAll.map(String); report.conflicts.rg++; }
        const pAll = distinct('pos'); const rp = first('pos'); if (pAll.length > 1) { alt.rp = pAll; report.conflicts.rp++; }
        const cAll = distinct('country'); const country = cAll.find(c => c !== 'US' && c !== 'USA') || cAll[0] || '';   // ex-US wins
        if (cAll.length > 1) { alt.country = cAll; report.conflicts.country++; }
        countryVotes[country] = (countryVotes[country] || 0) + 1;
        const p = { pk, n, name: first('name'), ry: first('yob'), rg, rp };
        const opt = { dob: first('dob'), school: first('school'), shot: first('shot'), state: first('state'), ht: first('ht'), home: first('home'), commit: first('commit') };
        for (const k in opt) if (opt[k] !== '') p[k] = opt[k];
        if (country && country !== (t.country || '')) p.ctry = country;
        p.t = [...new Set(rs.map(r => r.tk))].sort((a, b) => RECENCY.indexOf(a) - RECENCY.indexOf(b));
        const tag = first('tag'); if (tag) p.tag = tag;
        if (Object.keys(alt).length) p.alt = alt;
        p._pos = rp; p._idx = Math.min(...rs.map(r => r.idx));
        players.push(p);
      }
      players.sort((a, b) => (posRank(a._pos) < posRank(b._pos) ? -1 : posRank(a._pos) > posRank(b._pos) ? 1 : 0) || a._idx - b._idx);
      players.forEach(p => { delete p._pos; delete p._idx; });
      const country = Object.entries(countryVotes).sort((a, b) => b[1] - a[1] || (a[0] === 'US') - (b[0] === 'US'))[0][0];
      players.forEach(p => { if (p.ctry === country) delete p.ctry; });
      const label = t.squad === 2 ? `${t.club} ${t.lvl.replace(/U$/, '')}-2` : `${t.club}${t.prep ? ' Prep' : ''} ${t.lvl}`;
      const team = { team: label, country, club: t.club, lvl: t.lvl };
      if (t.squad === 2) team.squad = 2;
      team.levels = [...t.lvls].filter(Boolean); team.raw = [...t.raws]; team.tourneys = [...t.tourneys].sort((a, b) => RECENCY.indexOf(a) - RECENCY.indexOf(b));
      team.players = players;
      return team;
    });
  }
  // 4. one roster per club-season: a player listed at her own age level AND at a higher bracket (a play-up entry in another
  //    tournament) is kept at the lower level only. Players with no known birth year are left alone and listed in the report.
  const RANK = { '14U': 1, U15: 1, '16U': 2, U18: 2, '19U': 3, U22: 3 }, MAXAGE = { '14U': 14, U15: 14, '16U': 16, U18: 17, '19U': 99, U22: 99 };
  report.playUpRemoved = []; report.dualUnresolved = [];
  for (const sk of Object.keys(out)) {
    const start = +sk.slice(0, 4), groups = new Map();
    out[sk].forEach(t => { const g = `${t.club}`; (groups.get(g) || groups.set(g, []).get(g)).push(t); });
    for (const teams of groups.values()) {
      if (teams.length < 2) continue;
      const by = new Map();
      teams.forEach(t => t.players.forEach(p => (by.get(p.pk) || by.set(p.pk, []).get(p.pk)).push({ t, p })));
      for (const [pk, ents] of by) {
        if (new Set(ents.map(e => RANK[e.t.lvl])).size < 2) continue;
        const y = +ents[0].p.ry || +(ents.find(e => +e.p.ry) || { p: {} }).p.ry || (birthYears && birthYears.get(pk)) || 0;
        if (!y) { report.dualUnresolved.push(`${sk} ${teams[0].club}: ${ents[0].p.name} (${ents.map(e => e.t.lvl).join(', ')})`); continue; }
        const age = start - y;
        const keep = ents.filter(e => age <= MAXAGE[e.t.lvl]).sort((a, b) => RANK[a.t.lvl] - RANK[b.t.lvl])[0];
        if (!keep) continue;
        for (const e of ents) {
          if (e === keep || RANK[e.t.lvl] <= RANK[keep.t.lvl]) continue;
          for (const k in e.p) if (['dob', 'school', 'shot', 'state', 'ht', 'home', 'commit', 'ry', 'rg', 'n', 'rp'].includes(k) && (keep.p[k] === undefined || keep.p[k] === '') && e.p[k] !== '') keep.p[k] = e.p[k];
          keep.p.t = [...new Set([...(keep.p.t || []), ...(e.p.t || [])])].sort((a, b) => RECENCY.indexOf(a) - RECENCY.indexOf(b));
          e.t.players = e.t.players.filter(q => q !== e.p);
          report.playUpRemoved.push(`${sk} ${e.p.name}: removed from ${e.t.team}, kept at ${keep.t.team}`);
        }
      }
    }
    out[sk] = out[sk].filter(t => t.players.length);
  }
  report.oversize = [];   // a team cannot dress more than 22 players: anything bigger means two rosters were merged or a roster was pasted twice
  for (const sk in out) out[sk].forEach(t => { if (t.players.length > 22) report.oversize.push(`${sk} ${t.team}: ${t.players.length}`); });
  return { rosters: out, report };
}

// Flat, player-level view of buildRosters() output: one row per player per season (newest season first). Feeds build_master.js;
// no site page reads it. Same merged values as rosters.json, just not nested under teams.
function flattenPlayers(rosters) {
  const out = [];
  for (const sk of Object.keys(rosters).sort().reverse()) for (const t of rosters[sk]) for (const p of t.players)
    out.push(Object.assign({ pk: p.pk, season: sk, team: t.team, club: t.club, lvl: t.lvl, country: p.ctry || t.country }, p, { pk: p.pk }));
  return out;
}

/* --------------------------------- CLI ----------------------------------- */

function main() {
  const fs = require('fs'), path = require('path');
  const args = process.argv.slice(2);
  const opt = { out: 'rosters.json', report: 'import_report.json', repo: path.resolve(__dirname, '..'), known: '' };
  const files = [];
  for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i]; else files.push(args[i]); }
  if (!files.length) { console.error('usage: node tools/import_tourneys.js <tourneys.csv> [--out f] [--report f] [--repo dir] [--known a.json,b.json]'); process.exit(1); }
  const RC = require(path.join(opt.repo, 'tools', 'rosterClean.js'));
  const fnm = JSON.parse(fs.readFileSync(path.join(opt.repo, 'firstNameMap.json'), 'utf8')); RC.setNameMaps(fnm);
  const typeAliases = JSON.parse(fs.readFileSync(path.join(opt.repo, 'type_aliases.json'), 'utf8'));
  const d1 = JSON.parse(fs.readFileSync(path.join(opt.repo, 'd1.json'), 'utf8'));
  let known = null;
  if (opt.known) { known = new Set(); const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const k in o) { if (/^(pk|personkey)$/i.test(k) && typeof o[k] === 'string') known.add(o[k]); else walk(o[k]); } }; opt.known.split(',').forEach(f => walk(JSON.parse(fs.readFileSync(path.resolve(opt.repo, f), 'utf8')))); }
  const rows = parseCSV(fs.readFileSync(files[0], 'utf8'));
  let birthYears = null; const mf = path.resolve(opt.repo, opt.master || 'master.json');
  if (fs.existsSync(mf)) { birthYears = new Map(); JSON.parse(fs.readFileSync(mf, 'utf8')).forEach(r => { if (r.PersonKey && +r.BirthYr) birthYears.set(r.PersonKey, +r.BirthYr); }); }
  const windowSeasons = opt.window === undefined ? null : (String(opt.window).toLowerCase() === 'all' ? Infinity : +opt.window);
  const { rosters, report } = buildRosters(rows, { RC, typeAliases, d1, known, birthYears, windowSeasons });
  if (Object.keys(report.unknownTourneys).length) { console.error('STOP: unrecognized tournament names in the window:', report.unknownTourneys, '\nAdd them to CLASS_ORDER / RECENCY in this file.'); process.exit(2); }
  if (opt.out !== 'none') fs.writeFileSync(opt.out, JSON.stringify(rosters, null, 2));
  if (opt['players-out']) { const flat = flattenPlayers(rosters); fs.writeFileSync(opt['players-out'], JSON.stringify(flat)); console.log('players-out:', flat.length, 'rows,', new Set(flat.map(r => r.pk)).size, 'players'); }
  fs.writeFileSync(opt.report, JSON.stringify(report, null, 2));
  for (const s in rosters) console.log(s, rosters[s].length, 'teams', rosters[s].reduce((a, t) => a + t.players.length, 0), 'players');
  console.log('flags:', { swap: report.swapFlags.length, year: report.yearFlags.length, height: report.heightFlags.length, commitUnmatched: Object.keys(report.commitUnmatched).length, squadWarnings: report.squadWarnings.length, conflicts: report.conflicts });
}

const API = { buildRosters, cleanRow, flattenPlayers, parseCSV, stripTags, levelNorm, typeMatcher, normGrad, normShot, normCommit, posOf, seasonLabel, CLASS_ORDER, RECENCY, SQUAD2_CLUBS, PREP_LABEL_CLUBS };
if (typeof module !== 'undefined' && module.exports) { module.exports = API; if (typeof require !== 'undefined' && require.main === module) main(); }
else if (typeof window !== 'undefined') window.ImportTourneys = API;
