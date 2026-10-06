/* =========================================================================
   rosterIntake.js — HockeyFile / TopShelf: takes a pasted roster (one team, a
   multi-team spreadsheet, or heading-separated blocks), cleans it with the SAME
   code that built rosters.json (tools/import_tourneys.js cleanRow + rosterClean.js),
   compares it with what rosters.json already holds, and merges the result in.

   Used by the Teams tab on updates.html (loaded like rosterClean.js) and by
   tools/test_rosterIntake.js. Pure functions, no I/O.

   Flow:   parseInput(text)  ->  toRawRows(parsed, defaults)  ->  clean(rawRows, ctx)
           -> compare(existingTeam, candidate)  ->  applyPlan(rosters, season, plan)

   Rules live in TOURNEYS_NOTES.md / ROSTER_CLEANUP.md; this file adds only what a
   paste needs on top (column detection, matching an existing team, field-level
   comparison, and the merge).  Frozen seasons are never written.
   ========================================================================= */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./rosterClean.js'), require('./import_tourneys.js'));
  else root.RosterIntake = factory(root.RosterClean, root.ImportTourneys);
})(typeof self !== 'undefined' ? self : this, function (RC, IT) {
  'use strict';

  const FIELDS = ['n', 'ry', 'rg', 'rp', 'dob', 'school', 'shot', 'state', 'ht', 'home', 'commit'];
  const FIELD_LABEL = { n: '#', ry: 'Birth year', rg: 'Grad', rp: 'Pos', dob: 'DOB', school: 'School', shot: 'Shot', state: 'State', ht: 'Height', home: 'Hometown', commit: 'Committed', ctry: 'Country' };
  const MAX_ROSTER = 22;
  // Canadian U18 and U22 overlap in age (U22 is the stronger team but takes 15-year-olds; U18 holds most 15s plus 16-17s who did not make U22), so neither gets an age warning.
  const MAXAGE = { '14U': 14, U15: 14, '16U': 16, U18: 99, '19U': 99, U22: 99 };
  const norm = s => String(s == null ? '' : s).replace(/ /g, ' ').trim();
  const posRank = p => (p === '' || p == null ? 9 : p);

  /* ------------------------------ parsing ------------------------------ */

  const HEAD = {
    no: ['#', 'no', 'no.', 'num', 'number', 'jersey', 'jersey #', 'jersey no', 'jersey number', 'sweater', 'nbr'],
    name: ['name', 'player', 'player name', 'full name', 'athlete', 'skater'],
    first: ['first', 'first name', 'firstname', 'fname', 'given name', 'given'],
    last: ['last', 'last name', 'lastname', 'lname', 'surname', 'family name'],
    pos: ['pos', 'pos.', 'position', 'p'],
    yob: ['yob', 'birth year', 'birthyear', 'by', 'year of birth', 'birthyr', 'born'],
    dob: ['dob', 'birthdate', 'birth date', 'date of birth', 'birthday', 'bday'],
    grad: ['grad', 'grad year', 'gradyear', 'graduation', 'graduation year', 'class', 'class of', 'gy', 'hs grad', 'grad yr'],
    team: ['team', 'club', 'org', 'organization', 'team name', 'roster'],
    level: ['level', 'age', 'age group', 'division', 'tier', 'age level'],
    country: ['country', 'ctry', 'nation'],
    tourney: ['tourney', 'tournament', 'event'],
    season: ['season'],
    year: ['year'],
    committed: ['committed', 'commit', 'college', 'commitment', 'committed to', 'college commitment'],
    school: ['school', 'high school', 'prep school', 'school/club', 'hs'],
    shot: ['shot', 'shoots', 'catches', 'hand', 'handedness', 's/c', 'shoots/catches'],
    state: ['state', 'prov', 'province', 'state/prov', 'state/province', 'st', 'st/prov', 'region'],
    height: ['height', 'ht', 'ht.', 'hgt'],
    weight: ['weight', 'wt', 'wt.'],
    hometown: ['hometown', 'home', 'home town', 'city', 'birthplace', 'from', 'residence', 'hometown/state', 'city/state'],
  };
  const HEAD_LOOKUP = {}; Object.keys(HEAD).forEach(f => HEAD[f].forEach(h => { HEAD_LOOKUP[h] = f; }));
  const headKey = c => norm(c).toLowerCase().replace(/[^a-z0-9#./ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const headField = c => HEAD_LOOKUP[headKey(c)] || null;

  function splitCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else if (i + 1 >= line.length || line[i + 1] === ',') q = false; else cur += c; } else cur += c; }
      else if (c === '"' && cur === '') q = true;   // a quote opens a quoted field only at the start of a field; inside 5'6" it is just a character
      else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out;
  }
  function detectDelim(lines) {
    const sample = lines.filter(l => norm(l)).slice(0, 12);
    const count = ch => sample.reduce((a, l) => a + (l.split(ch).length - 1), 0);
    const tabs = count('\t'), pipes = count('|'), commas = count(',');
    if (tabs >= sample.length / 2 && tabs > 0) return '\t';
    if (pipes >= sample.length && pipes > 0) return '|';
    // commas only count as delimiters when most lines carry several of them (a lone "Hometown, ST" is not a CSV)
    if (sample.length && sample.filter(l => l.split(',').length >= 4).length >= sample.length / 2) return ',';
    return /\S {2,}\S/.test(sample.join('\n')) ? 'spaces' : null;
  }
  const splitLine = (line, delim) => delim === '\t' ? line.split('\t') : delim === '|' ? line.split('|') : delim === ',' ? splitCsvLine(line) : delim === 'spaces' ? line.trim().split(/\s{2,}/) : [line];

  const isPosWord = v => /^(f|d|g|c|lw|rw|w|ld|rd|a|fw|forward|forwards|defense|defence|defenseman|defenceman|goalie|goaltender|goal|attack|attaque|centre|center|wing|winger)$/i.test(norm(v));
  const isYear = v => /^(19|20)\d\d$/.test(norm(v));
  const isDate = v => /^\d{1,2}[\/.-]\d{1,2}[\/.-](\d{2}|\d{4})$/.test(norm(v)) || /^\d{4}-\d{2}-\d{2}$/.test(norm(v)) || /^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/.test(norm(v));
  const isHeight = v => /^\d\s*['’′-]\s*\d{1,2}\s*["”″]?$/.test(norm(v)) || /^\d\s*(ft|feet)\b/i.test(norm(v));

  // Guess what each column holds from its values (used when a paste has no header row).
  function inferMap(rows) {
    const ncol = Math.max(...rows.map(r => r.length)), map = {}, used = new Set();
    const col = i => rows.map(r => norm(r[i])).filter(Boolean);
    const frac = (vals, fn) => vals.length ? vals.filter(fn).length / vals.length : 0;
    const take = (field, i) => { if (!(field in map)) { map[field] = i; used.add(i); } };
    for (let i = 0; i < ncol; i++) {
      const v = col(i); if (!v.length) continue;
      if (frac(v, x => /^#?\d{1,2}$/.test(x)) > 0.8 && new Set(v).size > v.length * 0.7) take('no', i);
      else if (frac(v, isPosWord) > 0.8) take('pos', i);
      else if (frac(v, x => isYear(x) && +x >= 2005 && +x <= 2017) > 0.8) take('yob', i);
      else if (frac(v, x => isYear(x) && +x >= 2024 && +x <= 2038) > 0.8) take('grad', i);
      else if (frac(v, isDate) > 0.8) take('dob', i);
      else if (frac(v, isHeight) > 0.7) take('height', i);
      else if (frac(v, x => /^[LR]$/i.test(x)) > 0.8) take('shot', i);
      else if (frac(v, x => /^[A-Z]{2}$/.test(x)) > 0.8) take('state', i);
    }
    let best = -1, bestScore = 0;
    for (let i = 0; i < ncol; i++) {
      if (used.has(i)) continue; const v = col(i); if (!v.length) continue;
      const sc = frac(v, x => /^[A-Za-zÀ-ÿ'’.\- ]{3,}$/.test(x) && /\s/.test(x)) + 0.01 * v.join('').length / v.length;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best >= 0) take('name', best);
    for (let i = 0; i < ncol; i++) if (!used.has(i)) { const v = col(i); if (v.length && frac(v, x => /,/.test(x) || /^[A-Za-zÀ-ÿ'’.\- ]{3,}$/.test(x)) > 0.6) { take('hometown', i); break; } }
    return map;
  }

  const looksLikeHeader = cells => { const fs = cells.map(headField).filter(Boolean); return fs.length >= 2 && new Set(fs).size >= 2 && fs.some(f => ['name', 'first', 'last'].includes(f)) || (fs.length >= 3 && new Set(fs).size >= 3); };

  /* parseInput(text) -> { blocks: [ { heading, map, rows:[cells...], hasHeader } ], warnings } */
  function parseInput(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const delim = detectDelim(lines), warnings = [];
    const blocks = []; let cur = null;
    const open = heading => { cur = { heading: heading || '', header: null, rows: [] }; blocks.push(cur); return cur; };
    const nonEmpty = lines.map((l, i) => ({ l, i })).filter(x => norm(x.l));
    for (let k = 0; k < nonEmpty.length; k++) {
      const line = nonEmpty[k].l, cells = splitLine(line, delim).map(norm);
      const multi = cells.filter(Boolean).length >= 2;
      if (!multi) {
        // a lone line: a team heading when the next line is a table row / header, otherwise a one-column data row
        const next = nonEmpty[k + 1] ? splitLine(nonEmpty[k + 1].l, delim).map(norm) : null;
        const nextMulti = next && next.filter(Boolean).length >= 2;
        if (nextMulti || !cur) { if (nextMulti || !/^\d/.test(cells[0] || '')) { open(cells[0]); continue; } }
        if (cur) { cur.rows.push(cells); continue; }
      }
      if (looksLikeHeader(cells)) { if (!cur || cur.rows.length) open(cur ? cur.heading : ''); cur.header = cells; continue; }
      if (!cur) open('');
      cur.rows.push(cells);
    }
    blocks.forEach(b => {
      b.rows = b.rows.filter(r => r.some(Boolean));
      b.map = {};
      if (b.header) b.header.forEach((h, i) => { const f = headField(h); if (f && !(f in b.map)) b.map[f] = i; });
      else if (b.rows.length) { b.map = inferMap(b.rows); b.inferred = true; }
      if (b.map.year != null && !b.map.grad && !b.map.season) {
        const vs = b.rows.map(r => norm(r[b.map.year])).filter(Boolean);
        if (new Set(vs).size > 1 && vs.every(x => isYear(x) && +x >= 2024)) { b.map.grad = b.map.year; delete b.map.year; }
      }
      if (b.map.year != null && b.map.season == null) { b.map.season = b.map.year; delete b.map.year; }
    });
    const real = blocks.filter(b => b.rows.length);
    if (!real.length) warnings.push('Nothing to parse: no player rows found.');
    real.forEach(b => { if (b.map.name == null && b.map.first == null) warnings.push(`${b.heading || 'The paste'}: could not find a Name column.`); });
    return { blocks: real, warnings, delim };
  }

  /* Column preview support (the Teams tab shows the parsed paste as a table before checking it).
     COLUMN_CHOICES: what a column can be read as. columnFields(block) -> { colIndex: field } as parsed; columnCount(block).
     applyEdits(parsed, edits) -> parsed with the user's changes: edits[blockIndex] = { cols: { colIndex: field | '' ('' = ignore) }, drop: [rowIndex...] }.
     Pure, never mutates its input. */
  const COLUMN_CHOICES = [['', '(ignore)'], ['name', 'Name'], ['first', 'First name'], ['last', 'Last name'], ['no', '#'], ['pos', 'Position'], ['yob', 'Birth year'], ['dob', 'Birth date'],
    ['grad', 'Grad year'], ['height', 'Height'], ['shot', 'Shoots'], ['hometown', 'Hometown'], ['state', 'State / Prov'], ['country', 'Country'], ['school', 'School'],
    ['committed', 'Committed'], ['team', 'Team'], ['level', 'Level / age group'], ['season', 'Season'], ['tourney', 'Tourney']];
  const columnFields = b => { const out = {}; Object.keys(b.map || {}).forEach(f => { if (!(b.map[f] in out)) out[b.map[f]] = f; }); return out; };
  const columnCount = b => Math.max((b.header || []).length, ...b.rows.map(r => r.length), 0);
  function applyEdits(parsed, edits) {
    if (!edits) return parsed;
    const blocks = parsed.blocks.map((b, bi) => {
      const e = edits[bi]; if (!e) return b;
      const nb = Object.assign({}, b);
      if (e.drop && e.drop.length) { const d = new Set(e.drop); nb.rows = b.rows.filter((r, ri) => !d.has(ri)); }
      if (e.cols && Object.keys(e.cols).length) {
        const cf = columnFields(b); Object.keys(e.cols).forEach(c => { cf[c] = e.cols[c]; });
        nb.map = {}; Object.keys(cf).map(Number).sort((x, y) => x - y).forEach(c => { const f = cf[c]; if (f && !(f in nb.map)) nb.map[f] = c; });
        nb.edited = true;
      }
      return nb;
    });
    return Object.assign({}, parsed, { blocks });
  }

  /* ------------------------- name / level helpers ------------------------- */

  const smallWords = /^(de|la|le|van|von|der|di|du|da|st|mc|mac)$/i;
  function titleCase(n) {
    return n.toLowerCase().replace(/(^|[\s\-'’(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
  }
  // One pasted name -> { name, tag, notes[] }: Last-comma-First flipped, pronounce junk / AP / Injured tags and nicknames in quotes or parentheses removed
  // (kept as the tag, like "nickname: Lily"), accents stripped to ASCII, ALL-CAPS / all-lowercase recased, spacing collapsed.
  function cleanName(raw) {
    const notes = []; let t = norm(raw); const tags = [];
    t = RC.stripPronounce(t);
    const tg = RC.nameTags(t); if (tg.length) { tags.push(...tg); t = RC.stripNameTags(t); }
    t = t.replace(/\s*[“"‘(]\s*([^”"’)]{1,25}?)\s*[”"’)]\s*/g, (m, nick) => { tags.push('nickname: ' + nick.trim()); notes.push('nickname removed'); return ' '; }).replace(/\s+/g, ' ').trim();
    t = t.replace(/[\u2018\u2019\u02BC]/g, "'");   // O’Connor -> O'Connor (a nickname in quotes was already taken out above)
    const cm = t.match(/^([^,]+),\s*([^,]+)$/); if (cm && !/^(jr|sr|ii|iii|iv)\.?$/i.test(cm[2].trim())) { t = cm[2].trim() + ' ' + cm[1].trim(); notes.push('Last, First flipped'); }
    const un = RC.unaccent(t); if (un !== t) { t = un; notes.push('accents stripped'); }
    if (t.length > 3 && (t === t.toUpperCase() || t === t.toLowerCase()) && /[A-Za-z]/.test(t)) { t = titleCase(t); notes.push('case fixed'); }
    t = t.replace(/\s+/g, ' ').trim();
    return { name: t, tag: tags.join('; '), notes };
  }
  // Level token from a team heading/name: "Boston Jr Eagles 16U", "Selects U18AA", "East Coast Wizards 16-2" -> '16U' / 'U18' / '16U'
  function levelFromText(t) {
    const s = norm(t); let m = s.match(/\b(U\s?(1[0-9]|2[0-2])(?:AAA|AA|A|B)?)\b/i); if (m) return m[1].replace(/\s/g, '').toUpperCase();
    m = s.match(/\b((1[0-9]|2[0-2])\s?U(?:AAA|AA|A|B)?)\b/i); if (m) return m[1].replace(/\s/g, '').toUpperCase();
    m = s.match(/\b(1[0-9]|2[0-2])\s*-\s*[12]\b/); if (m) return m[1] + 'U';
    return '';
  }
  /* Birth dates: rosters.json keeps M/D/YYYY ("12/2/2008"). Sheets arrive as 2008-12-02, 12/02/2008, "Dec 2, 2008" or with a time, so they are
     all brought to M/D/YYYY before comparing (otherwise every date looks like a conflict). A date whose year is not plausible for a player
     (e.g. 01/31/0200) is unusable: normDob returns bad:true and the caller leaves it blank. A bare year is left as typed. */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function normDob(raw) {
    const t = norm(raw); if (!t || /^(19|20)\d\d$/.test(t)) return { v: t, bad: false };
    let y, m, d, x;
    if ((x = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T].*)?$/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?:[ T].*)?$/))) { y = +x[3]; m = +x[1]; d = +x[2]; if (m > 12 && d <= 12) { const z = m; m = d; d = z; } }
    else if ((x = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTHS[x[1].toLowerCase()]) { y = +x[3]; m = MONTHS[x[1].toLowerCase()]; d = +x[2]; }
    else if ((x = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/)) && MONTHS[x[2].toLowerCase()]) { y = +x[3]; m = MONTHS[x[2].toLowerCase()]; d = +x[1]; }
    else if ((x = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,3})$/))) return { v: '', bad: true };
    else return { v: t, bad: false };   // some other shape: keep as typed
    if (!(y >= 1990 && y <= 2016) || m < 1 || m > 12 || d < 1 || d > 31) return { v: '', bad: true };
    return { v: m + '/' + d + '/' + y, bad: false };
  }
  const countryFromState = st => (RC.CANADA_PROVINCE && (RC.CANADA_PROVINCE[st] || Object.values(RC.CANADA_PROVINCE).includes(st))) ? 'CAN' : '';

  /* toRawRows(parsed, defaults) -> rows in the importer's raw layout.
     defaults: { year (2026), tourney ('Misc'), team, level, country }  — a Team/Level/Country column or a block heading overrides these per row. */
  function toRawRows(parsed, d) {
    d = d || {}; const out = [], rowWarnings = [];
    parsed.blocks.forEach(b => {
      const m = b.map, cell = (r, f) => (m[f] != null ? norm(r[m[f]]) : '');
      b.rows.forEach((r, ri) => {
        let name = cell(r, 'name'); if (!name && (m.first != null || m.last != null)) name = (cell(r, 'first') + ' ' + cell(r, 'last')).trim();
        else if (name && m.first != null && m.last != null && !/\s/.test(name)) name = (cell(r, 'first') + ' ' + cell(r, 'last')).trim();
        if (!name || /^(name|player|totals?|goalies|forwards|defense|defence|skaters)$/i.test(name)) return;
        if (/^\d+$/.test(name)) { rowWarnings.push(`${b.heading || 'paste'} row ${ri + 1}: "${name}" is not a name (skipped)`); return; }
        const cn = cleanName(name);
        let team = cell(r, 'team') || b.heading || d.team || '';
        let level = cell(r, 'level') || levelFromText(team) || d.level || '';
        // Club-name spellings seen in club-supplied sheets: "Delta Hockey Academy Black Women's U18 Prep", "Stanstead U18". Drop "Women's" and a trailing age
        // group (it is the Level column's job) so the Type table can recognise the club; "Prep" alone is kept (Shattuck's naming depends on it).
        if (cell(r, 'level')) team = team.replace(/\bwomen['\u2019]?s\b/ig, '').replace(/\s*[-\u2013]?\s*\b(?:U\d\d|\d\dU)(?:\s*prep)?\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
        else team = team.replace(/\bwomen['\u2019]?s\b/ig, '').replace(/\s{2,}/g, ' ').trim();
        const hometown = cell(r, 'hometown'), state = cell(r, 'state');
        let country = cell(r, 'country').toUpperCase().replace(/^CANADA$/, 'CAN').replace(/^(USA|UNITED STATES)$/, 'US') || d.country || '';
        const yearCell = cell(r, 'season') || ''; const yr = (yearCell.match(/(20\d\d)/) || [])[1] || d.year || '';
        const gradRaw = cell(r, 'grad'), yobRaw = cell(r, 'yob');
        let dob = cell(r, 'dob'), yob = yobRaw;
        if (dob) { const nd = normDob(dob); if (nd.bad) { rowWarnings.push(`${cn.name}: birth date "${dob}" is not a usable date, so it was left blank (the date on file, if any, is kept)`); dob = ''; } else dob = nd.v; }
        if (!yob && dob) { const ym = dob.match(/(19|20)\d\d/); if (ym && !/^(19|20)\d\d$/.test(dob)) { /* yob is derived later by the caller from a full DOB */ } }
        out.push({
          Year: String(yr), Tourney: cell(r, 'tourney') || d.tourney || 'Misc', Level: level, '#': cell(r, 'no').replace(/^#/, ''), Name: cn.name, Pos: cell(r, 'pos'),
          YOB: yob, Grad: gradRaw, Committed: cell(r, 'committed'), Team: team, Country: country, DOB: dob, School: cell(r, 'school'), Shot: cell(r, 'shot'),
          State: state, Height: cell(r, 'height'), Hometown: hometown, NameTag: cn.tag, _notes: cn.notes, _src: (b.heading || '') + '#' + (ri + 1),
        });
      });
    });
    return { rows: out, rowWarnings };
  }

  /* ------------------------------ cleaning ------------------------------ */

  const emptyReport = () => ({ unknownTourneys: {}, swapFlags: [], yearFlags: [], heightFlags: [], commitUnmatched: {}, unmatchedOrgs: {}, badLevel: {}, squadWarnings: [], conflicts: { n: 0, rg: 0, rp: 0, country: 0 }, tagged: 0 });
  const normKey = s => norm(s).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  const labelOf = (club, lvl, squad, prep) => squad === 2 ? `${club} ${lvl.replace(/U$/, '')}-2` : `${club}${prep ? ' Prep' : ''} ${lvl}`;

  /* clean(rawRows, ctx) -> { teams: [candidate], flags, summary }
     ctx: { typeAliases, d1, known (Set of personkeys), birthYears (Map pk -> year), season ('2026-27'), clubSpellings (Map lower -> spelling) } */
  function clean(rawRows, ctx) {
    const match = IT.typeMatcher(ctx.typeAliases || []);
    const start = +(String(ctx.season || '').slice(0, 4)) || 0;
    const canon = s => (ctx.clubSpellings && ctx.clubSpellings.get(s.toLowerCase())) || s;
    const byKey = new Map(), flags = [], summary = { rows: rawRows.length, accents: 0, recased: 0, nicknames: 0, flipped: 0, dropped: 0 };
    rawRows.forEach((r, idx) => {
      const rep = emptyReport(), S = { RC, d1: ctx.d1, known: ctx.known || null, match, canon, report: rep };
      // country: explicit > Type table > Canadian province in the row > US
      const hit = match(IT.stripTags(r.Team));
      let country = r.Country || (hit && hit.country) || countryFromState(norm(r.State)) || 'US';
      const cr = IT.cleanRow(Object.assign({}, r, { Country: country }), idx, S);
      if (!cr) { summary.dropped++; flags.push({ src: r._src, name: r.Name, level: 'error', msg: `Unknown tournament "${r.Tourney}" (use Stoney, Pittsburgh, MNRosters, NIT or Misc)` }); return; }
      (r._notes || []).forEach(n => { if (n === 'accents stripped') summary.accents++; else if (n === 'case fixed') summary.recased++; else if (n === 'nickname removed') summary.nicknames++; else if (n === 'Last, First flipped') summary.flipped++; });
      const rowFlags = [];
      rep.swapFlags.forEach(m => rowFlags.push({ level: 'warn', msg: 'Possible swapped first/last name: ' + m.replace(/^.*?:\s*/, '') }));
      rep.yearFlags.forEach(m => rowFlags.push({ level: 'warn', msg: m.replace(/^.*?:\s*/, '') }));
      rep.heightFlags.forEach(m => rowFlags.push({ level: 'warn', msg: m.replace(/^.*?:\s*/, '') }));
      Object.keys(rep.commitUnmatched).forEach(k => rowFlags.push({ level: 'info', msg: `Committed school "${k}" is not on the D1 list (kept as typed)` }));
      (rep.commitJunk || []).forEach(m => rowFlags.push({ level: 'info', msg: m.replace(/^.*?:\s*/, '') }));
      if (norm(r.Grad) && !cr.grad) rowFlags.push({ level: 'warn', msg: `Grad "${norm(r.Grad)}" has no usable year (left blank)` });
      if (!cr.name || !/\S+\s+\S+/.test(cr.name)) rowFlags.push({ level: 'warn', msg: 'Name has only one word' });
      if (/\d/.test(cr.name)) rowFlags.push({ level: 'warn', msg: 'Name contains a digit' });
      // birth year: explicit, else from a full DOB
      let ry = cr.yob; if (!ry && cr.dob) { const dm = cr.dob.match(/(19|20)\d\d/); if (dm) ry = dm[0]; }
      cr.yob = ry;
      const by = +ry || (ctx.birthYears && ctx.birthYears.get(cr.pk)) || 0;
      if (by && start && MAXAGE[cr.lvl] != null && (start - by) > MAXAGE[cr.lvl]) rowFlags.push({ level: 'warn', msg: `Born ${by}: too old for ${cr.lvl} in ${ctx.season}` });
      if (by && cr.grad && !(+cr.grad - by >= 16 && +cr.grad - by <= 20)) rowFlags.push({ level: 'warn', msg: `Grad ${cr.grad} does not fit birth year ${by}` });
      const tkey = `${cr.club}|${cr.lvl}|${cr.squad}`;
      let c = byKey.get(tkey);
      if (!c) { c = { key: tkey, club: cr.club, lvl: cr.lvl, squad: cr.squad, prep: false, raws: new Set(), levels: new Set(), tourneys: new Set(), players: new Map(), dupes: [], unmatchedOrg: !hit && !!IT.stripTags(r.Team), hit }; byKey.set(tkey, c); }
      if (cr.prep) c.prep = true; c.raws.add(cr.rawTeam); if (cr.rawLevel) c.levels.add(cr.rawLevel); c.tourneys.add(cr.tk);
      const prev = c.players.get(cr.pk);
      if (prev) { c.dupes.push(cr.name); FIELDS.forEach(f => { const k = { n: 'n', ry: 'yob', rg: 'grad', rp: 'pos', dob: 'dob', school: 'school', shot: 'shot', state: 'state', ht: 'ht', home: 'home', commit: 'commit' }[f]; if (!prev.row[k] && cr[k]) prev.row[k] = cr[k]; }); prev.flags.push(...rowFlags); }
      else c.players.set(cr.pk, { row: cr, flags: rowFlags, src: r._src });
    });
    const teams = [];
    for (const c of byKey.values()) {
      const players = [], votes = {};
      c.players.forEach(({ row: q, flags, src }) => {
        const p = { pk: q.pk, n: q.n, name: q.name, ry: q.yob, rg: q.grad, rp: q.pos };
        const opt = { dob: q.dob, school: q.school, shot: q.shot, state: q.state, ht: q.ht, home: q.home, commit: q.commit };
        Object.keys(opt).forEach(k => { if (opt[k] !== '' && opt[k] != null) p[k] = opt[k]; });
        p._country = q.country; p.t = [q.tk]; if (q.tag) p.tag = q.tag;
        votes[q.country] = (votes[q.country] || 0) + 1;
        players.push({ p, flags, src });
      });
      const country = Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] === 'US') - (b[0] === 'US'))[0][0];
      players.forEach(({ p }) => { if (p._country && p._country !== country) p.ctry = p._country; delete p._country; });
      players.sort((a, b) => posRank(a.p.rp) < posRank(b.p.rp) ? -1 : posRank(a.p.rp) > posRank(b.p.rp) ? 1 : 0);
      const dupNums = {}; players.forEach(({ p }) => { if (p.n) (dupNums[p.n] = dupNums[p.n] || []).push(p.name); });
      const teamFlags = [];
      Object.keys(dupNums).forEach(n => { if (dupNums[n].length > 1) teamFlags.push({ level: 'warn', msg: `Jersey #${n} appears for ${dupNums[n].join(' and ')}` }); });
      if (players.length > MAX_ROSTER) teamFlags.push({ level: 'warn', msg: `${players.length} players is more than the ${MAX_ROSTER}-player maximum: two rosters pasted together, or one twice?` });
      if (c.dupes.length) teamFlags.push({ level: 'info', msg: `Listed twice in the paste and merged: ${c.dupes.join(', ')}` });
      if (c.unmatchedOrg) teamFlags.push({ level: 'info', msg: `"${c.club}" has no Type-table entry; the club name is used as typed` });
      if (!['14U', '16U', '19U', 'U15', 'U18', 'U22'].includes(c.lvl)) teamFlags.push({ level: 'warn', msg: `Level "${c.lvl}" is not one of 14U/16U/19U (US) or U15/U18/U22 (Canada)` });
      const cand = { key: c.key, club: c.club, lvl: c.lvl, squad: c.squad, prep: c.prep, team: labelOf(c.club, c.lvl, c.squad, c.prep), country, levels: [...c.levels], raw: [...c.raws], tourneys: [...c.tourneys].sort((a, b) => IT.RECENCY.indexOf(a) - IT.RECENCY.indexOf(b)), players: players.map(x => x.p), flagsByPk: {}, teamFlags };
      players.forEach(x => { if (x.flags.length) cand.flagsByPk[x.p.pk] = x.flags; });
      teams.push(cand);
    }
    teams.sort((a, b) => a.team.localeCompare(b.team));
    return { teams, summary, flags };
  }

  /* ------------------------------ comparing ------------------------------ */

  const sameVal = (f, a, b) => f === 'dob' ? normDob(a).v === normDob(b).v : norm(a).toLowerCase() === norm(b).toLowerCase();
  function lev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n); let prev = Array.from({ length: n + 1 }, (_, i) => i); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }

  // Find the teams already on file for a candidate. exact = same club + level + squad; similar = same club at another level, or a near-identical club spelling.
  function findExisting(seasonTeams, cand) {
    const list = seasonTeams || [];
    let exact = list.findIndex(t => normKey(t.club) === normKey(cand.club) && t.lvl === cand.lvl && (t.squad || 1) === cand.squad), via = exact >= 0 ? 'name' : '';
    // Same roster under another name or level label (club-supplied sheets say "Women's U18 Prep", we hold U22): when most of the paste's players are
    // already on ONE team this season, that is the team. The label on file is kept; the paste only adds or fills.
    // (also when the name matches a team whose roster is not the paste's at all and another team's is: the level label was the odd one out)
    if (cand.players.length >= 8) {
      const pks = new Set(cand.players.map(p => p.pk)), cnt = t => t.players.filter(p => pks.has(p.pk)).length; let best = -1, bestN = 0;
      list.forEach((t, i) => { const n = cnt(t); if (n > bestN) { bestN = n; best = i; } });
      if (best >= 0 && best !== exact && bestN >= Math.ceil(0.7 * pks.size) && (exact < 0 || cnt(list[exact]) < 0.3 * pks.size)) { exact = best; via = 'roster'; }
    }
    const similar = [];
    list.forEach((t, i) => { if (i === exact) return; const a = normKey(t.club), b = normKey(cand.club); if (a === b) similar.push({ i, why: `same club at ${t.lvl}${t.squad === 2 ? ' (#2 team)' : ''}`, team: t.team }); else if (a && b && (a.includes(b) || b.includes(a) || lev(a, b) <= 2)) similar.push({ i, why: 'similar club name', team: t.team }); });
    return { exact, similar, via };
  }

  /* compare(existingTeam | null, cand) ->
     { status: 'new'|'identical'|'adds'|'conflicts', added:[player], fills:[{pk,name,field,value}], conflicts:[{pk,name,field,have,paste}], same:n, notInPaste:[player], near:[{paste,onFile}], overlap } */
  function compare(ex, cand) {
    const res = { added: [], fills: [], conflicts: [], same: 0, notInPaste: [], near: [], overlap: null };
    if (!ex) { res.added = cand.players.slice(); res.status = 'new'; return res; }
    const have = new Map(ex.players.map(p => [p.pk, p])), seen = new Set();
    const exKeys = ex.players.map(p => p.pk);
    cand.players.forEach(q => {
      const p = have.get(q.pk);
      if (!p) {
        // a pasted player who is not on file but looks like one who is (and who is not in the paste): a typo (<= 2 letters off), or the same surname with
        // first names that start alike (Adds / Addison, Cynnimin / Cynnim: nicknames and short forms)
        const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
        const near = exKeys.find(k => k !== q.pk && !cand.players.some(z => z.pk === k) && ((lev(k, q.pk) <= 2 && k.split('|')[0][0] === q.pk.split('|')[0][0]) ||
          (k.split('|')[0] === q.pk.split('|')[0] && commonPrefix(k.split('|')[1] || '', q.pk.split('|')[1] || '') >= 3)));
        if (near) res.near.push({ paste: q, onFile: have.get(near) });
        res.added.push(q); return;
      }
      seen.add(q.pk); let diff = false;
      FIELDS.forEach(f => {
        const a = norm(p[f]), b = norm(q[f]); if (!b) return;
        if (!a) { res.fills.push({ pk: q.pk, name: p.name, field: f, value: b }); diff = true; }
        else if (!sameVal(f, a, b)) { res.conflicts.push({ pk: q.pk, name: p.name, field: f, have: a, paste: b }); diff = true; }
      });
      if (norm(p.name) !== norm(q.name)) {
        // via 'personkey': the first names differ (Vienna / Vivi) but both resolve to the same personkey through the alias map: the same player, only the display name is open
        const first = n => norm(n).toLowerCase().split(/\s+/)[0];
        res.conflicts.push({ pk: q.pk, name: p.name, field: 'name', have: p.name, paste: q.name, via: first(p.name) !== first(q.name) ? 'personkey' : '' }); diff = true;
      }
      const pc = p.ctry || ex.country, qc = q.ctry || cand.country;
      if (!diff) res.same++;
    });
    res.notInPaste = ex.players.filter(p => !seen.has(p.pk));
    res.overlap = cand.players.length ? seen.size / Math.min(cand.players.length, ex.players.length || 1) : 0;
    res.status = res.conflicts.length ? 'conflicts' : (res.added.length || res.fills.length) ? 'adds' : 'identical';
    return res;
  }

  /* ------------------------------- applying ------------------------------- */

  const sortT = t => [...new Set(t)].sort((a, b) => IT.RECENCY.indexOf(a) - IT.RECENCY.indexOf(b));
  const clone = x => JSON.parse(JSON.stringify(x));

  /* applyPlan(rosters, season, plan, opts) -> { rosters (new object, input untouched), log, renames }.
     plan: [ { cand, existingIndex (or -1/null for a new team),
               accept: { 'pk|field': true }      replace the on-file value with the pasted one (the old one goes to alt for n/rg/rp)
               names:  { pk: 'Typed Name' }      with accept[pk|name]: use this spelling instead of the pasted one
               noFill: { pk: true }              do not fill this player's blanks from the paste
               near:   { pastePk: { mode: 'keep'|'replace'|'custom'|'add', onFilePk, name } }   a pasted player that looks like one on file
               skipAdd: { pk: true }, remove: [pk],
               relabel: { team, club, lvl }      new label for the team (new team: its name; on-file team: rename it) } ]
     Blank fields on file are always filled (unless noFill). Players on file but not in the paste are kept unless listed in remove.
     A spelling that changes a player's personkey cannot be changed in rosters.json alone (the key is in every season and every source), so it is
     returned in renames: [{ fromPk, fromName, toName, toPk }] for the caller to queue in source_corrections.json. A same-key respelling is applied in place.
     opts.frozen = seasons that may not be written. */
  function applyPlan(rosters, season, plan, opts) {
    opts = opts || {};
    if ((opts.frozen || []).includes(season)) throw new Error(`Season ${season} is frozen (archive); it cannot be changed from here.`);
    const out = clone(rosters); if (!out[season]) out[season] = [];
    const log = [], renames = [];
    const setName = (p, nm, ctx) => {
      nm = cleanName(nm).name || norm(nm); if (!nm || nm === p.name) return 0;
      const key = RC.makePersonKey(nm);
      if (key === p.pk) { p.name = nm; return 1; }
      renames.push({ fromPk: p.pk, fromName: p.name, toName: nm, toPk: key, team: ctx });
      return 0;
    };
    const fillFrom = (p, q, noFill) => {
      let n = 0;
      if (!noFill) FIELDS.forEach(f => { const b = norm(q[f]); if (b && !norm(p[f])) { p[f] = q[f]; n++; } });
      if (q.ctry && !p.ctry) p.ctry = q.ctry;
      if (q.tag && !p.tag) p.tag = q.tag;
      p.t = sortT([...(p.t || []), ...(q.t || [])]);
      return n;
    };
    plan.forEach(item => {
      const cand = item.cand, accept = item.accept || {}, skip = item.skipAdd || {}, removeSet = new Set(item.remove || []);
      const noFill = item.noFill || {}, nearMap = item.near || {}, typed = item.names || {}, rl = item.relabel || null;
      if (item.existingIndex == null || item.existingIndex < 0) {
        const t = { team: cand.team, country: cand.country, club: cand.club, lvl: cand.lvl };
        if (rl) { if (rl.team) t.team = rl.team; if (rl.club) t.club = rl.club; if (rl.lvl) t.lvl = rl.lvl; }
        if (cand.squad === 2) t.squad = 2;
        t.levels = cand.levels.slice(); t.raw = cand.raw.slice(); t.tourneys = cand.tourneys.slice();
        t.players = cand.players.filter(p => !skip[p.pk]).map(p => clone(p));
        out[season].push(t); log.push(`new team ${t.team}: ${t.players.length} players`); return;
      }
      const ex = out[season][item.existingIndex]; const have = new Map(ex.players.map(p => [p.pk, p]));
      let added = 0, filled = 0, replaced = 0, removed = 0, relabeled = '';
      if (rl && ((rl.team && rl.team !== ex.team) || (rl.lvl && rl.lvl !== ex.lvl) || (rl.club && rl.club !== ex.club))) {
        relabeled = `${ex.team} -> ${rl.team || ex.team}`;
        if (rl.team) ex.team = rl.team; if (rl.club) ex.club = rl.club; if (rl.lvl) ex.lvl = rl.lvl;
      }
      cand.players.forEach(q => {
        let p = have.get(q.pk);
        const nr = nearMap[q.pk];
        if (!p && nr && nr.mode && nr.mode !== 'add' && have.get(nr.onFilePk)) {
          const op = have.get(nr.onFilePk);
          filled += fillFrom(op, q, noFill[q.pk]);
          if (nr.mode === 'replace') replaced += setName(op, q.name, ex.team);
          else if (nr.mode === 'custom') replaced += setName(op, nr.name || q.name, ex.team);
          return;
        }
        if (!p) { if (skip[q.pk]) return; ex.players.push(clone(q)); added++; return; }
        if (!noFill[q.pk]) FIELDS.forEach(f => { const b = norm(q[f]); if (b && !norm(p[f])) { p[f] = q[f]; filled++; } });
        FIELDS.forEach(f => {
          const b = norm(q[f]); if (!b) return; const a = norm(p[f]);
          if (a && !sameVal(f, a, b) && accept[q.pk + '|' + f]) {
            if (['n', 'rg', 'rp'].includes(f)) { p.alt = p.alt || {}; p.alt[f] = [...new Set([...(p.alt[f] || []), a])]; }
            p[f] = q[f]; replaced++;
          }
        });
        if (accept[q.pk + '|name'] && norm(q.name) !== norm(p.name)) replaced += setName(p, typed[q.pk] || q.name, ex.team);
        if (q.ctry && !p.ctry && q.ctry !== ex.country) p.ctry = q.ctry;
        if (q.tag && !p.tag) p.tag = q.tag;
        p.t = sortT([...(p.t || []), ...(q.t || [])]);
      });
      if (removeSet.size) { const before = ex.players.length; ex.players = ex.players.filter(p => !removeSet.has(p.pk)); removed = before - ex.players.length; }
      ex.raw = [...new Set([...(ex.raw || []), ...cand.raw])]; ex.levels = [...new Set([...(ex.levels || []), ...cand.levels])];
      ex.tourneys = sortT([...(ex.tourneys || []), ...cand.tourneys]);
      ex.players = ex.players.map((p, i) => ({ p, i })).sort((x, y) => (posRank(x.p.rp) < posRank(y.p.rp) ? -1 : posRank(x.p.rp) > posRank(y.p.rp) ? 1 : 0) || x.i - y.i).map(x => x.p);
      log.push(`${ex.team}: +${added} players, ${filled} fields filled, ${replaced} replaced, ${removed} removed${relabeled ? ', renamed (' + relabeled + ')' : ''}`);
    });
    return { rosters: out, log, renames };
  }

  // Final sanity checks on a rosters object before it is written: duplicate personkeys on a team, oversize teams, empty teams.
  function validate(rosters, seasons) {
    const problems = [];
    (seasons || Object.keys(rosters)).forEach(s => (rosters[s] || []).forEach(t => {
      const seen = new Set(); t.players.forEach(p => { if (seen.has(p.pk)) problems.push(`${s} ${t.team}: duplicate ${p.pk}`); seen.add(p.pk); if (!/^[a-z]+\|[a-z]+$/.test(p.pk)) problems.push(`${s} ${t.team}: odd personkey "${p.pk}" for ${p.name}`); });
      if (t.players.length > MAX_ROSTER) problems.push(`${s} ${t.team}: ${t.players.length} players`);
      if (!t.players.length) problems.push(`${s} ${t.team}: empty team`);
    }));
    return problems;
  }

  return { parseInput, applyEdits, columnFields, columnCount, COLUMN_CHOICES, toRawRows, clean, findExisting, compare, applyPlan, validate, cleanName, levelFromText, normDob, labelOf, normKey, FIELDS, FIELD_LABEL, MAX_ROSTER, inferMap };
});
