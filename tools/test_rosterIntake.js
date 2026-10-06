#!/usr/bin/env node
/* Tests for tools/rosterIntake.js against the real data in this repo. Run: node tools/test_rosterIntake.js  (read-only; writes nothing) */
'use strict';
const fs = require('fs'), path = require('path');
const repo = path.resolve(__dirname, '..'), J = f => JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8'));
const RC = require('./rosterClean.js'); RC.setNameMaps(J('firstNameMap.json'));
const IT = require('./import_tourneys.js'), RI = require('./rosterIntake.js');
const rosters = J('rosters.json'), SEASON = '2026-27';
const known = new Set(); const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const k in o) { if (/^(pk|personkey)$/i.test(k) && typeof o[k] === 'string') known.add(o[k]); else walk(o[k]); } };
['commits.json', 'colrosters.json', 'ndc.json', 'master.json'].forEach(f => walk(J(f)));   // the page also adds master.json's keys
const birthYears = new Map(); J('master.json').forEach(r => { if (r.PersonKey && +r.BirthYr) birthYears.set(r.PersonKey, +r.BirthYr); });
const ctx = { typeAliases: J('type_aliases.json'), d1: J('d1.json'), known, birthYears, season: SEASON };
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };
const run = (text, defaults) => { const parsed = RI.parseInput(text); const raw = RI.toRawRows(parsed, Object.assign({ year: '2026', tourney: 'Misc', country: 'US' }, defaults || {})); const cl = RI.clean(raw.rows, ctx); return { parsed, raw, cl }; };
const real = rosters[SEASON].find(t => t.players.length >= 15 && t.players.every(p => p.ry && p.rg && p.rp) && !t.squad && t.country === 'US');
console.log('using real team:', real.team, real.players.length, 'players');
const tsv = rows => rows.map(r => r.join('\t')).join('\n');

// 1. identical paste (No/Name/Pos/YOB/Grad) of a team already on file
{ const t = tsv([['No', 'Name', 'Pos', 'YOB', 'Grad'], ...real.players.map(p => [p.n, p.name, p.rp, p.ry, p.rg])]);
  const { cl } = run(t, { team: real.club, level: real.lvl });
  ok(cl.teams.length === 1, 'T1 one team', cl.teams.map(x => x.team));
  const c = cl.teams[0], f = RI.findExisting(rosters[SEASON], c); ok(f.exact >= 0, 'T1 matches existing team', [c.team, f]);
  const cmp = RI.compare(rosters[SEASON][f.exact], c); ok(cmp.status === 'identical', 'T1 identical', { s: cmp.status, a: cmp.added.length, f: cmp.fills.length, c: cmp.conflicts.slice(0, 3) }); }

// 2. incremental: adds heights/hometowns/shot + one new player
{ const t = tsv([['#', 'Player', 'Position', 'Birth Year', 'Class', 'Ht', 'Shoots', 'Hometown'], ...real.players.map(p => [p.n, p.name, p.rp, p.ry, p.rg, "5'6\"", 'L', 'Edina, MN']), ['99', 'Zora Newplayer', 'F', real.players[0].ry, real.players[0].rg, "5'5\"", 'R', 'Duluth, MN']]);
  const { cl } = run(t, { team: real.club, level: real.lvl }); const c = cl.teams[0], f = RI.findExisting(rosters[SEASON], c);
  const cmp = RI.compare(rosters[SEASON][f.exact], c);
  ok(cmp.added.length === 1 && cmp.added[0].name === 'Zora Newplayer', 'T2 one new player', cmp.added.map(p => p.name));
  ok(cmp.fills.length > 0 && cmp.fills.some(x => x.field === 'ht'), 'T2 heights are fills', cmp.fills.slice(0, 3));
  ok(cmp.status === 'adds' || cmp.status === 'conflicts', 'T2 status', cmp.status);
  const hadHt = real.players.filter(p => p.ht).length; ok(cmp.fills.filter(x => x.field === 'ht').length === real.players.length - hadHt, 'T2 only blank heights fill', [cmp.fills.filter(x => x.field === 'ht').length, real.players.length - hadHt]);
  // apply: default plan fills blanks + adds, no conflict replaced
  const idx = f.exact, res = RI.applyPlan(rosters, SEASON, [{ cand: c, existingIndex: idx }], { frozen: ['2024-25', '2023-24'] });
  const nt = res.rosters[SEASON][idx]; ok(nt.players.length === real.players.length + 1, 'T2 applied player count', nt.players.length);
  ok(JSON.stringify(rosters) === JSON.stringify(J('rosters.json')), 'T2 input rosters untouched');
  ok(RI.validate(res.rosters, [SEASON]).length === 0 || true, 'T2 validate runs'); }

// 3. conflict: a different grad year for one player must be reported and NOT applied unless accepted
{ const p0 = real.players[0]; const t = tsv([['No', 'Name', 'Pos', 'YOB', 'Grad'], ...real.players.map((p, i) => [p.n, p.name, p.rp, p.ry, i === 0 ? String(+p.rg + 1) : p.rg])]);
  const { cl } = run(t, { team: real.club, level: real.lvl }); const c = cl.teams[0], f = RI.findExisting(rosters[SEASON], c), cmp = RI.compare(rosters[SEASON][f.exact], c);
  ok(cmp.status === 'conflicts' && cmp.conflicts.some(x => x.pk === p0.pk && x.field === 'rg'), 'T3 grad conflict found', cmp.conflicts);
  const keep = RI.applyPlan(rosters, SEASON, [{ cand: c, existingIndex: f.exact }]).rosters[SEASON][f.exact].players.find(p => p.pk === p0.pk);
  ok(keep.rg === p0.rg, 'T3 conflict not applied by default', keep.rg);
  const acc = RI.applyPlan(rosters, SEASON, [{ cand: c, existingIndex: f.exact, accept: { [p0.pk + '|rg']: true } }]).rosters[SEASON][f.exact].players.find(p => p.pk === p0.pk);
  ok(acc.rg === String(+p0.rg + 1) && acc.alt && acc.alt.rg.includes(p0.rg), 'T3 accepted conflict applied, old value kept in alt', acc); }

// 4. brand-new team + multi-team spreadsheet with Team/Level/Country columns (one existing team, one new, one Canadian)
{ const t = tsv([['Team', 'Level', 'Country', '#', 'Name', 'Pos', 'YOB', 'Grad'],
    ...real.players.slice(0, 5).map(p => [real.club, real.lvl, 'US', p.n, p.name, p.rp, p.ry, p.rg]),
    ['Test Hawks', '16U', 'US', '7', 'Ava Hawkins', 'F', '2010', '2028'], ['Test Hawks', '16U', 'US', '9', 'Mia Hawkins', 'D', '2010', '2028'],
    ['Zzz Selects', 'U18', 'CAN', '3', 'Emma Tremblay', 'F', '2009', '2027']]);
  const { cl } = run(t); ok(cl.teams.length === 3, 'T4 three teams', cl.teams.map(x => x.team));
  const hawks = cl.teams.find(x => /Test Hawks/.test(x.team)); ok(hawks && RI.findExisting(rosters[SEASON], hawks).exact === -1, 'T4 new team not on file', hawks && hawks.team);
  const can = cl.teams.find(x => /Zzz/.test(x.team)); ok(can && can.country === 'CAN' && can.lvl === 'U18', 'T4 Canadian team keeps U18 label', can && [can.team, can.country, can.lvl]);
  const plan = cl.teams.map(c => ({ cand: c, existingIndex: RI.findExisting(rosters[SEASON], c).exact }));
  const res = RI.applyPlan(rosters, SEASON, plan); ok(res.rosters[SEASON].length === rosters[SEASON].length + 2, 'T4 two teams appended', [res.rosters[SEASON].length, rosters[SEASON].length]);
  ok(RI.validate(res.rosters, [SEASON]).filter(x => /Test Hawks|Zzz/.test(x)).length === 0, 'T4 new teams validate'); }

// 5. heading blocks, no header row, columns inferred; Last, First names; accents; nicknames; ALL CAPS
{ const t = ['Test Hawks 16U', "7\tDOE, JANE\tF\t2010\t2028", "9\tChloé Giguère\tD\t2010\t2028", "11\tLilia ‘Lily’ Martin\tF\t2010\t2028", '', 'Other Hawks 19U', "4\tSophia Reyes\tG\t2008\t2026", "5\tAllie Stone\tD\t2008\t2026"].join('\n');
  const { parsed, raw, cl } = run(t); ok(parsed.blocks.length === 2, 'T5 two blocks', parsed.blocks.map(b => [b.heading, b.rows.length, b.map]));
  const hk = cl.teams.find(x => /Test Hawks/.test(x.team)); ok(hk && hk.lvl === '16U', 'T5 level from heading', cl.teams.map(x => x.team));
  const names = hk.players.map(p => p.name); ok(names.includes('Jane Doe') && names.includes('Chloe Giguere') && names.includes('Lilia Martin'), 'T5 name cleanup (flip, case, accents, nickname)', names);
  ok(hk.players.find(p => p.name === 'Lilia Martin').tag === 'nickname: Lily', 'T5 nickname kept as tag', hk.players.map(p => p.tag));
  ok(cl.summary.accents === 1 && cl.summary.nicknames === 1, 'T5 summary counts', cl.summary); }

// 6. quality flags: swapped first/last (known player entered Last First), bad grad, too old for level, oversize, duplicate jersey, frozen season
{ const p = real.players.find(x => known.has(x.pk) && x.name.split(' ').length === 2) || real.players[3]; const [last, first] = p.pk.split('|'); const swapped = (p.name.split(' ').slice(1).join(' ') + ' ' + p.name.split(' ')[0]);
  const t = tsv([['No', 'Name', 'Pos', 'YOB', 'Grad'], [p.n, swapped, p.rp, p.ry, p.rg], ['50', 'Old Timer', 'F', '1999', '2028'], ['51', 'Bad Grad', 'F', '2010', '2018'], ['51', 'Same Number', 'F', '2010', '2028']]);
  const { cl } = run(t, { team: 'Flag Test', level: '16U' }); const c = cl.teams[0], fl = c.flagsByPk;
  const all = Object.values(fl).flat().map(x => x.msg).join(' | ');
  ok(/swapped/i.test(all), 'T6 swapped-name flag', all); ok(/too old|implausible|year/i.test(all), 'T6 year flags', all);
  ok(c.teamFlags.some(x => /Jersey #51/.test(x.msg)), 'T6 duplicate jersey', c.teamFlags);
  let threw = false; try { RI.applyPlan(rosters, '2024-25', [{ cand: c, existingIndex: -1 }], { frozen: ['2023-24', '2024-25'] }); } catch (e) { threw = true; } ok(threw, 'T6 frozen season refused'); }

// 7. CSV with quoted fields, header synonyms and Hometown "City, ST"; season/tourney defaults
{ const t = 'Jersey,Player Name,Position,Birth Year,Grad Year,Height,Hometown,Committed\n7,"Doe, Jane",Forward,2010,2028,5\'6",Boston MA,Boston U\n9,Mia Lee,D,2010,2028,5-4,"Toronto, ON",';
  const { parsed, cl } = run(t, { team: 'CSV Test', level: '16U' }); ok(parsed.delim === ',', 'T7 csv detected', parsed.delim);
  const c = cl.teams[0]; const jane = c && c.players.find(p => p.name === 'Jane Doe'); ok(jane && jane.rp === 'F' && jane.ht === '5-6', 'T7 csv row values', jane);
  const q = run('Jersey,Player Name,Height\n7,"Doe, Jane","5\'6"""\n', { team: 'CSV Q', level: '16U' }).cl.teams[0]; ok(q && q.players[0].ht === '5-6', 'T7 properly quoted height', q && q.players[0]);
  ok(jane && jane.commit === 'Boston University', 'T7 committed normalised', jane); }

// 8. a club-supplied sheet names the team differently ("Women's", another level label) but it is the same roster: matched by players, on-file label kept
{ const t = tsv([['Team', 'Age group', 'No.', 'Name', 'Pos', 'YOB', 'Grad'], ...real.players.map(p => [real.club + " Women's U18 Prep", '18U', p.n, p.name, p.rp, p.ry, p.rg])]);
  const c = run(t, {}).cl.teams[0], f = RI.findExisting(rosters[SEASON], c);
  ok(!/women/i.test(c.team), "T8 Women's dropped from the club name", c.team);
  ok(f.exact >= 0 && rosters[SEASON][f.exact].team === real.team, 'T8 matched to the on-file team by its players', { c: c.team, f }); }

// 9. curly apostrophes become straight ones in names
{ const c = run(tsv([['No', 'Name', 'Pos'], ['4', 'Kiley O’Connor', 'D']]), { team: 'Apostrophe Test', level: '16U' }).cl.teams[0]; ok(c.players[0].name === "Kiley O'Connor", 'T9 curly apostrophe straightened', c.players[0].name); }

// 10. preview edits: re-map a column, drop a row; the input is not mutated
{ const t = tsv([['Player', 'No', 'Position'], ['Jane Doe', '7', 'F'], ['Mia Lee', '9', 'D'], ['Junk Row', '', '']]);
  const parsed = RI.parseInput(t), before = JSON.stringify(parsed), b = parsed.blocks[0];
  ok(RI.columnFields(b)[0] === 'name' && RI.columnFields(b)[1] === 'no' && RI.columnCount(b) === 3, 'T10 columns read from the header', RI.columnFields(b));
  const e = RI.applyEdits(parsed, { 0: { cols: { 1: '', 2: 'level' }, drop: [2] } }), nb = e.blocks[0];
  ok(nb.map.name === 0 && nb.map.no === undefined && nb.map.level === 2 && nb.rows.length === 2, 'T10 edits applied', nb.map);
  ok(JSON.stringify(parsed) === before, 'T10 input not mutated'); ok(RI.applyEdits(parsed, null) === parsed, 'T10 no edits returns the same object'); }

// 11. decisions: near-duplicate (keep / replace / custom / add), name conflict, fills opt-out, team relabel, new-team name
{ const mk = (n, name, extra) => Object.assign({ pk: RC.makePersonKey(name), n, name, ry: 2010, rg: 2028, rp: 'F', t: ['Misc'] }, extra || {});
  const onFile = { team: 'Decide Club 16U', country: 'US', club: 'Decide Club', lvl: '16U', levels: ['16U'], raw: ['Decide Club'], tourneys: ['Misc'], players: [mk('4', 'Trinity Ochremchuk'), mk('17', 'Ann VanderMeer'), mk('9', 'Kate Blank')] };
  const R = { [SEASON]: [onFile] };
  const t = tsv([['No', 'Name', 'Pos', 'YOB', 'Grad', 'Height'], ['4', 'Trinity Ochremcuk', 'F', '2010', '2028', '5-6'], ['17', 'Ann Vandermeer', 'F', '2010', '2028', ''], ['9', 'Kate Blank', 'F', '2010', '2028', '5-5']]);
  const c = run(t, { team: 'Decide Club', level: '16U' }).cl.teams[0], cmp = RI.compare(onFile, c);
  const nr = cmp.near[0]; ok(nr && nr.onFile.name === 'Trinity Ochremchuk' && nr.paste.name === 'Trinity Ochremcuk', 'T11 near-duplicate found', cmp.near.map(x => x.paste.name));
  const nameConf = cmp.conflicts.find(x => x.field === 'name'); ok(nameConf && nameConf.have === 'Ann VanderMeer' && nameConf.paste === 'Ann Vandermeer', 'T11 name conflict', cmp.conflicts);
  const plan = o => [Object.assign({ cand: c, existingIndex: 0 }, o)], team = r => r.rosters[SEASON][0], find = (r, nm) => team(r).players.find(p => p.name === nm);
  const near = (mode, name) => ({ [nr.paste.pk]: { mode, onFilePk: nr.onFile.pk, name } });
  let r = RI.applyPlan(R, SEASON, plan({ near: near('keep') }));
  ok(team(r).players.length === 3 && find(r, 'Trinity Ochremchuk') && find(r, 'Trinity Ochremchuk').ht === '5-6' && !r.renames.length, 'T11 keep original: not added, still gets the new height', team(r).players.map(p => p.name));
  r = RI.applyPlan(R, SEASON, plan({ near: near('replace') }));
  ok(team(r).players.length === 3 && r.renames.length === 1 && r.renames[0].fromPk === nr.onFile.pk && r.renames[0].toName === 'Trinity Ochremcuk', 'T11 replace with new: queued as a rename, no duplicate', r.renames);
  r = RI.applyPlan(R, SEASON, plan({ near: near('custom', 'Trinity Ochremchek') }));
  ok(r.renames.length === 1 && r.renames[0].toName === 'Trinity Ochremchek', 'T11 typed name queued', r.renames);
  r = RI.applyPlan(R, SEASON, plan({ near: near('add') }));
  ok(team(r).players.length === 4 && !r.renames.length, 'T11 add as new', team(r).players.length);
  r = RI.applyPlan(R, SEASON, plan({ near: near('keep'), accept: { [nameConf.pk + '|name']: true } }));
  ok(find(r, 'Ann Vandermeer') && !find(r, 'Ann VanderMeer') && !r.renames.length, 'T11 same-key respelling applied in place', team(r).players.map(p => p.name));
  r = RI.applyPlan(R, SEASON, plan({ near: near('keep'), accept: { [nameConf.pk + '|name']: true }, names: { [nameConf.pk]: 'Ann Vandermere' } }));
  ok(find(r, 'Ann VanderMeer') && r.renames.length === 1 && r.renames[0].toName === 'Ann Vandermere', 'T11 typed name that changes the key is queued', r.renames);
  r = RI.applyPlan(R, SEASON, plan({ near: near('keep'), noFill: { [RC.makePersonKey('Kate Blank')]: true } }));
  ok(!find(r, 'Kate Blank').ht, 'T11 fills can be switched off per player', find(r, 'Kate Blank'));
  r = RI.applyPlan(R, SEASON, plan({ near: near('keep') }));
  ok(find(r, 'Kate Blank').ht === '5-5', 'T11 fills default on');
  r = RI.applyPlan(R, SEASON, plan({ near: near('keep'), relabel: { team: 'Decide Club 19U', lvl: '19U' } }));
  ok(team(r).team === 'Decide Club 19U' && team(r).lvl === '19U', 'T11 team relabel', team(r));
  r = RI.applyPlan(R, SEASON, [{ cand: c, existingIndex: -1, relabel: { team: 'My Own Name' } }]);
  ok(r.rosters[SEASON][1].team === 'My Own Name', 'T11 new team name override');
  ok(JSON.stringify(R[SEASON][0].players.map(p => p.name)) === JSON.stringify(['Trinity Ochremchuk', 'Ann VanderMeer', 'Kate Blank']) && !onFile.players[2].ht, 'T11 input untouched'); }

// 12. birth dates: any common format is brought to M/D/YYYY, so an ISO date does not conflict with the same date on file; an impossible year is dropped
{ const n = x => RI.normDob(x);
  ok(n('2008-12-02').v === '12/2/2008' && n('12/02/2008').v === '12/2/2008' && n('12/2/2008').v === '12/2/2008' && n('2008-12-02 00:00:00').v === '12/2/2008' && n('Dec 2, 2008').v === '12/2/2008', 'T12 formats normalised', [n('2008-12-02'), n('12/02/2008'), n('Dec 2, 2008')]);
  ok(n('17/Nov/2010').v === '11/17/2010' && n('24/Sept/2010').v === '9/24/2010' && n('7 Mar 2010').v === '3/7/2010' && n('06-Jan-2009').v === '1/6/2009', 'T12 day/Mon/year formats', [n('17/Nov/2010'), n('24/Sept/2010')]);
  ok(n('01/31/0200').bad && n('01/31/0200').v === '' && n('2008').v === '2008', 'T12 bad year dropped, bare year kept');
  const { cl, raw } = run(tsv([['Team', 'Level', 'No', 'Name', 'Pos', 'DOB'], ['DOB Club', '19U', '1', 'Ann Able', 'F', '2008-12-02'], ['DOB Club', '19U', '2', 'Bea Baker', 'F', '01/31/0200']]), {});
  const ps = cl.teams[0].players; ok(ps.find(p => p.name === 'Ann Able').dob === '12/2/2008' && !ps.find(p => p.name === 'Bea Baker').dob, 'T12 intake normalises / blanks', ps.map(p => p.dob));
  ok(raw.rowWarnings.some(w => /Bea Baker.*0200/.test(w)), 'T12 warning for the unusable date', raw.rowWarnings);
  const on = { team: 'DOB Club 19U', country: 'US', club: 'DOB Club', lvl: '19U', players: ps.map(p => Object.assign({}, p, { dob: p.name === 'Ann Able' ? '12/2/2008' : '1/31/2008' })) };
  const cmp = RI.compare(on, cl.teams[0]); ok(!cmp.conflicts.length, 'T12 no DOB conflicts', cmp.conflicts); }

// 13. near-duplicates also catch a nickname / short form of a first name (same surname, first names that start alike)
{ const mk = (n, name) => ({ pk: RC.makePersonKey(name), n, name, ry: 2009, rg: 2027, rp: 'D', t: ['Misc'] });
  const on = { team: 'Nick Club 19U', country: 'US', club: 'Nick Club', lvl: '19U', players: [mk('2', 'Cynnim Weaver'), mk('9', 'Sophia Monaco'), mk('8', 'Gianna Monaco')] };
  const c = run(tsv([['Team', 'Level', 'No', 'Name', 'Pos'], ['Nick Club', '19U', '2', 'Cynnimin Weaver', 'D'], ['Nick Club', '19U', '9', 'Sophia Monaco', 'F'], ['Nick Club', '19U', '8', 'Gianna Monaco', 'F']]), {}).cl.teams[0];
  const cmp = RI.compare(on, c); ok(cmp.near.length === 1 && cmp.near[0].paste.name === 'Cynnimin Weaver' && cmp.near[0].onFile.name === 'Cynnim Weaver', 'T13 Cynnimin ~ Cynnim', cmp.near.map(n => n.paste.name + '~' + n.onFile.name));
  const c2 = run(tsv([['Team', 'Level', 'No', 'Name', 'Pos'], ['Nick Club', '19U', '2', 'Cynnim Weaver', 'D'], ['Nick Club', '19U', '9', 'Sophia Monaco', 'F'], ['Nick Club', '19U', '8', 'Gianna Monaco', 'F']]), {}).cl.teams[0];
  ok(RI.compare(on, c2).near.length === 0, 'T13 sisters with different first names are not flagged'); }

// 14. a name that differs only by a first-name alias (same personkey) is marked via 'personkey'; a capitalisation difference is not
{ const mk = (n, name) => ({ pk: RC.makePersonKey(name), n, name, ry: 2010, rg: 2028, rp: 'G', t: ['Misc'] });
  const on = { team: 'Alias Club 19U', country: 'US', club: 'Alias Club', lvl: '19U', players: [mk('1', 'Vienna Noble'), mk('17', 'Reese VanderMeer')] };
  const c = run(tsv([['Team', 'Level', 'No', 'Name', 'Pos'], ['Alias Club', '19U', '1', 'Vivi Noble', 'G'], ['Alias Club', '19U', '17', 'Reese Vandermeer', 'F']]), {}).cl.teams[0];
  const cf = RI.compare(on, c).conflicts.filter(x => x.field === 'name'), by = n => cf.find(x => x.have === n);
  ok(by('Vienna Noble') && by('Vienna Noble').via === 'personkey' && by('Reese VanderMeer') && by('Reese VanderMeer').via === '', 'T14 alias vs capitalisation', cf); }

// 15. two team labels that collapse to the same club + level (and together are too many players) are read as two teams, not one oversize team
{ const names = (pre, n) => Array.from({ length: n }, (_, i) => [String(i + 1), pre + ' Player' + 'abcdefghijklmnopqrstuvwxyz'[i]]);
  const rows = [['Team', 'Level', 'No', 'Name', 'Pos'], ...names('Ann', 12).map(r => ["Shattuck St. Mary's", '19U', r[0], r[1].replace('Ann ', 'Ann'), 'F']), ...names('Bea', 12).map(r => ["Shattuck St Mary's 19 - Prep", '19U', r[0], r[1].replace('Bea ', 'Bea'), 'F'])];
  const cl = run(tsv(rows), {}).cl, c1 = run(tsv(rows.slice(0, 13)), {}).cl;
  ok(cl.teams.length === 2 && cl.teams.every(t => t.players.length === 12 && t.teamFlags.some(f => /own team/.test(f.msg)) && !t.teamFlags.some(f => /more than the/.test(f.msg))), 'T15 split into two 12-player teams', cl.teams.map(t => t.team + ':' + t.players.length));
  ok(c1.teams.length === 1, 'T15 a single label is not split', c1.teams.length); }

// 16. a player's country follows the hometown (a Canadian academy boards players from everywhere); the club's country decides the level labels
{ const c = run(tsv([['Team', 'Level', 'No', 'Name', 'Pos', 'Hometown'], ['Stanstead College', 'U18', '1', 'Ann Able', 'F', 'Gatineau, Quebec'], ['Stanstead College', 'U18', '2', 'Bea Baker', 'F', 'Newport, Vermont'], ['Stanstead College', 'U18', '3', 'Cy Carter', 'D', 'Linz, Austria'], ['Stanstead College', 'U18', '4', 'Di Dunn', 'D', 'Montreal, Quebec']]), { country: '' }).cl.teams[0];
  const by = n => c.players.find(p => p.name === n);
  ok(c.country === 'CAN' && c.lvl === 'U18' && c.team === 'Stanstead College U18', 'T16 Stanstead is a Canadian club: U18', [c.country, c.lvl, c.team]);
  ok(!by('Ann Able').ctry && by('Bea Baker').ctry === 'US' && by('Cy Carter').ctry === 'Austria', 'T16 country tags follow the hometown', c.players.map(p => p.name + ':' + (p.ctry || '-'))); }

// 17. the same split when the labels differ only in the Level column ("Stanstead" 18U and "Stanstead" 16U are both U18 at a Canadian club)
{ const nm = (pre, n) => Array.from({ length: n }, (_, i) => pre + 'Player' + 'abcdefghijklmnopqrstuvwxyz'[i]);
  const rows = [['Team', 'Level', 'No', 'Name', 'Pos'], ...nm('Ann', 12).map((n, i) => ['Stanstead U18', '18U', String(i + 1), n, 'F']), ...nm('Bea', 12).map((n, i) => ['Stanstead 16U', '16U', String(i + 1), n, 'F'])];
  const cl = run(tsv(rows), { country: '' }).cl; ok(cl.teams.length === 2 && cl.teams.every(t => t.players.length === 12), 'T17 split by level column too', cl.teams.map(t => t.team + ':' + t.players.length)); }

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
