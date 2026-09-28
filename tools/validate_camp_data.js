#!/usr/bin/env node
/* =========================================================================
   validate_camp_data.js -- standing data-quality gate for ndc.json and
   provrosters.json (see tools/CAMP_DATA.md for the semantics these checks
   are protecting). Run this on every rebuild/re-paste of either file, not
   just once -- these sources get hand-updated throughout the season and
   the same error shapes recur each cycle:
     - a mistyped name that breaks the personkey join to commits/master
     - an accidental re-paste producing a same-row-identity duplicate
     - a birth-year/grad-year typo or column mismap
     - an ambiguous nickname that needs a human to confirm which player

   Uses the real tools/rosterClean.js functions (makePersonKey,
   computeSwapIssue, checkYearSanity) -- never hand-simulates this logic,
   per ROSTER_CLEANUP.md's own rule.

   Usage:
     node tools/validate_camp_data.js provrosters.json \
       --name=Name --year=Year --dupekey=personkey,Year,Province \
       --yob=BirthYr --grad=Grad-EST

     node tools/validate_camp_data.js ndc.json \
       --name=NAME --year=YEAR --dupekey=personkey,YEAR,CAMP \
       --yob=BIRTHYR --grad=GRAD

   --dupekey is deliberately explicit rather than hardcoded per file, because
   each source has its own real reason a player can have more than one row
   in the same year -- confirmed by running this tool against both files:
     - provrosters.json: a legitimate multi-province-same-year row (a real
       billet case, e.g. Hayley McDonald, Manitoba + Ontario) looks
       identical to an accidental re-paste if you only key on
       personkey+Year. Needs Province in the key.
     - ndc.json: NDC's cascading announcement schedule means a player can
       legitimately appear at both a U1617 camp row AND a U18 camp row in
       the same calendar year (confirmed against real data: 110 such
       players in the 2025 cycle alone, e.g. Addison McLay). Needs CAMP in
       the key -- personkey+Year alone flags all 110 as false "duplicates".
   Keying on the fuller tuple lets this script tell a real re-paste apart
   from a real multi-row case: same full key twice is flagged as a likely
   paste error (dupeExact); same personkey+Year but a different value on
   the last key field is flagged separately for a human to confirm
   (multiKey) rather than either silently dropped or silently ignored.
   ========================================================================= */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  argv.forEach(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else out._.push(a);
  });
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targetFile = args._[0];
if (!targetFile) {
  console.error('Usage: node validate_camp_data.js <file.json> --name=Field --year=Field [--dupekey=f1,f2,...] [--yob=Field] [--grad=Field] [--pk=Field]');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const RosterClean = require(path.join(repoRoot, 'tools', 'rosterClean.js'));
const firstNameMap = require(path.join(repoRoot, 'firstNameMap.json'));
RosterClean.setNameMaps(firstNameMap);

const NAME_FIELD = args.name || 'Name';
const YEAR_FIELD = args.year || 'Year';
const PK_FIELD = args.pk || 'personkey';
const YOB_FIELD = args.yob || '';
const GRAD_FIELD = args.grad || '';
const DUPEKEY_FIELDS = (args.dupekey || `${PK_FIELD},${YEAR_FIELD}`).split(',').map(s => s.trim());

const rows = JSON.parse(fs.readFileSync(path.resolve(targetFile), 'utf8'));
if (!Array.isArray(rows)) { console.error('Expected a flat JSON array of rows.'); process.exit(1); }
console.log(`Loaded ${rows.length} rows from ${targetFile}`);

// Known-personkeys corpus, for computeSwapIssue -- built once from the
// sources every migrated file is meant to join against.
const knownPks = new Set();
function addPksFrom(file, extractor) {
  const p = path.join(repoRoot, file);
  if (!fs.existsSync(p)) { console.log(`  (skip ${file}: not found)`); return; }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    let count = 0;
    extractor(j, pk => { if (pk) { knownPks.add(String(pk).toLowerCase()); count++; } });
    console.log(`  loaded ${count} pks from ${file}`);
  } catch (e) { console.log(`  could not load ${file}: ${e.message}`); }
}
console.log('\nBuilding known-personkeys corpus:');
const flatExtract = (keyNames) => (j, add) => {
  const arr = Array.isArray(j) ? j : (j.rows || j.data || Object.values(j));
  (Array.isArray(arr) ? arr : []).forEach(r => { for (const k of keyNames) if (r[k]) { add(r[k]); return; } });
};
addPksFrom('master.json', flatExtract(['PersonKey', 'personkey', 'pk']));
addPksFrom('commits.json', flatExtract(['personkey', 'PersonKey', 'pk']));
addPksFrom('ndc.json', flatExtract(['personkey', 'PersonKey', 'pk']));
addPksFrom('provrosters.json', flatExtract(['personkey', 'PersonKey', 'pk']));
addPksFrom('colrosters.json', (j, add) => {
  if (Array.isArray(j)) j.forEach(r => add(r.pk || r.personkey));
  else Object.values(j).forEach(school => {
    if (Array.isArray(school)) school.forEach(r => add(r.pk || r.personkey));
    else if (school && typeof school === 'object') Object.values(school).forEach(season => {
      if (Array.isArray(season)) season.forEach(r => add(r.pk || r.personkey));
    });
  });
});
console.log('Total known pks:', knownPks.size);

const issues = { pkMismatch: [], swap: [], yearSanity: [], ambigNick: [], dupeExact: [], multiKey: [] };
const seenExact = new Map();     // full dupekey -> row #
const seenByPkYear = new Map();  // personkey+year prefix (all dupekey fields except the last) -> [{row, lastFieldVal}]

rows.forEach((r, i) => {
  const name = (r[NAME_FIELD] || '').trim();
  const csvPk = String(r[PK_FIELD] || '').trim().toLowerCase();
  if (!name) return;

  const computedPk = RosterClean.makePersonKey(name);
  if (computedPk !== csvPk) issues.pkMismatch.push({ row: i + 2, name, csvPk, computedPk });

  const swapIssue = RosterClean.computeSwapIssue(name, computedPk, knownPks);
  if (swapIssue) issues.swap.push({ row: i + 2, name, pk: computedPk, msg: swapIssue });

  if (YOB_FIELD || GRAD_FIELD) {
    const yearIssues = RosterClean.checkYearSanity(YOB_FIELD ? r[YOB_FIELD] : '', GRAD_FIELD ? r[GRAD_FIELD] : '');
    if (yearIssues.length) issues.yearSanity.push({ row: i + 2, name, msgs: yearIssues });
  }

  const firstTok = name.split(/\s+/)[0].toLowerCase();
  if (RosterClean.AMBIGUOUS_NICKNAMES.has(firstTok)) issues.ambigNick.push({ row: i + 2, name, pk: computedPk });

  // Duplicate check: full dupekey (e.g. personkey+Year+Province) vs. the
  // narrower personkey+Year prefix (all fields but the last), so a same-
  // province-same-year repeat and a different-province-same-year repeat
  // get told apart -- see the file header for why this distinction matters
  // for provrosters.json specifically.
  const fullKey = DUPEKEY_FIELDS.map(f => String(r[f] || '').trim().toLowerCase()).join('|');
  if (seenExact.has(fullKey)) issues.dupeExact.push({ row: i + 2, name, key: fullKey, dupeOfRow: seenExact.get(fullKey) });
  else seenExact.set(fullKey, i + 2);

  if (DUPEKEY_FIELDS.length > 2) {
    const prefixKey = DUPEKEY_FIELDS.slice(0, -1).map(f => String(r[f] || '').trim().toLowerCase()).join('|');
    const lastField = DUPEKEY_FIELDS[DUPEKEY_FIELDS.length - 1];
    const lastVal = String(r[lastField] || '').trim();
    if (!seenByPkYear.has(prefixKey)) seenByPkYear.set(prefixKey, []);
    const group = seenByPkYear.get(prefixKey);
    const distinctVals = new Set(group.map(g => g.lastVal));
    if (group.length && !distinctVals.has(lastVal)) {
      issues.multiKey.push({ row: i + 2, name, prefixKey, field: lastField, thisVal: lastVal, otherRows: group.map(g => g.row + ':' + g.lastVal) });
    }
    group.push({ row: i + 2, lastVal });
  }
});

console.log('\n=== VALIDATION RESULTS ===');
console.log('personkey mismatches (stored vs recomputed):', issues.pkMismatch.length);
issues.pkMismatch.slice(0, 30).forEach(x => console.log('  row', x.row, x.name, '| stored:', x.csvPk, '| computed:', x.computedPk));

console.log('\npossible swapped names:', issues.swap.length);
issues.swap.forEach(x => console.log('  row', x.row, x.name, '->', x.msg));

console.log('\nyear sanity flags:', issues.yearSanity.length);
issues.yearSanity.forEach(x => console.log('  row', x.row, x.name, x.msgs));

console.log('\nambiguous nicknames:', issues.ambigNick.length);
issues.ambigNick.forEach(x => console.log('  row', x.row, x.name, x.pk));

console.log(`\nexact duplicates (same ${DUPEKEY_FIELDS.join('+')} twice -- likely a re-paste, drop one):`, issues.dupeExact.length);
issues.dupeExact.slice(0, 30).forEach(x => console.log('  row', x.row, x.name, 'duplicates row', x.dupeOfRow, '| key:', x.key));

if (DUPEKEY_FIELDS.length > 2) {
  console.log(`\nsame ${DUPEKEY_FIELDS.slice(0,-1).join('+')} but different ${DUPEKEY_FIELDS[DUPEKEY_FIELDS.length-1]} (confirm real, e.g. a billet/multi-province case -- not auto-flagged as an error):`, issues.multiKey.length);
  issues.multiKey.forEach(x => console.log('  row', x.row, x.name, '| this row:', x.field + '=' + x.thisVal, '| other row(s):', x.otherRows.join(', ')));
}

const totalErrors = issues.pkMismatch.length + issues.swap.length + issues.yearSanity.length + issues.dupeExact.length;
console.log('\n' + (totalErrors ? `${totalErrors} issue(s) need a look before this file ships.` : 'Clean -- no blocking issues.'));
process.exit(totalErrors ? 1 : 0);
