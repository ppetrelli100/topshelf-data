#!/usr/bin/env python3
"""Build the Hudl side of the Hub for the Teams-page cards.  Run AFTER build_hub_json.py (it reads hub/hub_*.json).

Outputs (topshelf-data/hub/):
  hub_toi.json   merged time-on-ice, both sources, NEPSAC-style:  rows [ti, si, pk, name, pos, src, mask, gp, toi, shifts, pp, pk_]
                 src 0 = TPE, 1 = Hudl.  mask = which sources hold that team-game (bit 1 TPE, 2 Hudl).
                 With sources E switched on, a row counts when src is the lowest-numbered source in (mask AND E)
                 => one source per game, never summed across sources.  Seconds.  Goalies excluded.
                 'games' = {"ti|si": [tpe, hudl]} team-games per source (for the checkbox counts).
  hub_hudl.json  full Hudl data per player-team-season (all Hudl games, duplicates between two Hudl accounts removed).
Hudl and TPE stats are never added together; paired games (hudl_game_pair) are one real game with two sources.
Usage: python3 build_hub_hudl.py [EXPORT_DIR] [TOPSHELF_DATA_DIR]
"""
import sys, os, json, re, subprocess, collections, tempfile, glob
import pandas as pd, numpy as np

HOME = os.path.expanduser('~')
EXP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, 'mnt/Hub Export 2026-10-31')
TSD = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HOME, 'mnt/topshelf-data')
OUT = os.path.join(TSD, 'hub')
rd = lambda f, **k: pd.read_csv(os.path.join(EXP, f), low_memory=False, **k)
jl = lambda f: json.load(open(os.path.join(OUT, f), encoding='utf-8'))

# ---------- the TPE side, from the already-built hub files ----------
meta = jl('hub_meta.json'); TEAMS = meta['teams']; SEAS = meta['seasons']
HP = jl('hub_players.json'); PK = [r[0] for r in HP['rows']]; PNAME = {r[0]: r[1] for r in HP['rows']}
HG = jl('hub_games.json'); GROW = HG['rows']
tpe_gid = {r[0]: i for i, r in enumerate(GROW)}           # export game uuid -> hub gi
tpe_g = collections.defaultdict(list)                     # (tpe real-game id, team) -> [(pk, toi, shots against, goals against)]
tpe_rows = collections.defaultdict(list)                  # (tpe real-game id, team) -> [(pk, pos, toi, shifts, pp, pk)]
for fn in sorted(glob.glob(os.path.join(OUT, 'hub_pgs_*.json'))):
    d = json.load(open(fn)); h = {c: i for i, c in enumerate(d['header'])}
    for r in d['rows']:
        if not r[h['toi_seconds']]: continue
        if r[h['pos']] == 'G':        # goalies: kept apart from the skater rows (shots against, goals against, for the scouting card)
            ga_ = r[h['goals_against']] or 0; sv_ = r[h['saves']] or 0; sa_ = r[h['shots_against']] or (sv_ + ga_)
            tpe_g[(r[h['gi']], TEAMS[r[h['ti']]])].append((PK[r[h['pi']]], r[h['toi_seconds']] or 0, sa_, ga_)); continue
        tpe_rows[(r[h['gi']], TEAMS[r[h['ti']]])].append((PK[r[h['pi']]], r[h['pos']], r[h['toi_seconds']] or 0, r[h['shifts']] or 0,
                                                          r[h['pp_toi_seconds']] or 0, r[h['pk_toi_seconds']] or 0,
                                                          r[h['goals']] or 0, r[h['assists']] or 0, r[h['shots_on_goal']] or 0,
                                                          r[h['on_ice_xg_for']], r[h['on_ice_xg_against']]))
tpe_season = {i: r[2] for i, r in enumerate(GROW)}        # hub_games col 2 = season index

# ---------- Hudl games ----------
season = rd('season.csv'); SEASON = dict(zip(season.id, season.name)); SI = {s: i for i, s in enumerate(SEAS)}
game = rd('game.csv', usecols=['id', 'game_date', 'season_id', 'source_system', 'source_record_id'])
hg = game[game.source_system == 'hudl'].copy()
HAVE_H = set(hg.source_record_id.astype(str))          # Hudl match ids the export already holds
_xp = os.path.join(OUT, 'hub_game_exclusions.json')
HUDL_EXCL = {(str(g['hudl_id']), g['team']) for g in json.load(open(_xp, encoding='utf-8')).get('hudl_games', [])} if os.path.exists(_xp) else set()
_wp = os.path.join(OUT, 'hub_season_window.json')
WSTART = json.load(open(_wp, encoding='utf-8'))['starts'] if os.path.exists(_wp) else {}
_n0 = len(hg); hg = hg[[(str(d)[:10] >= WSTART.get(SEASON.get(sid), "0000")) for sid, d in zip(hg.season_id, hg.game_date)]].copy()
print('season window: dropped %d Hudl game(s) dated before their season start' % (_n0 - len(hg)))
team = rd('team.csv'); ident = rd('team_identity.csv'); IDN = dict(zip(ident.id, ident.name))
TEAM = {i: (IDN[idn] if isinstance(idn, str) and idn in IDN else nm) for i, idn, nm in zip(team.id, team.identity_id, team.name)}
pair = rd('hudl_game_pair.csv'); PAIR = dict(zip(pair.hudl_game_id, pair.tpe_game_id))

PGS = ['id', 'game_id', 'player_id', 'team_id', 'toi_seconds', 'shifts', 'shots_on_goal', 'shot_attempts', 'shots_missed_net', 'blocked_shots', 'plus_minus']
pgs = rd('player_game_stats.csv', usecols=PGS); pgs = pgs[pgs.game_id.isin(hg.id)]
det = rd('player_game_stats_detail.csv', usecols=['pgs_id', 'pp_toi_seconds', 'pk_toi_seconds', 'faceoffs_won', 'faceoffs_lost'])
hs = rd('hudl_player_game_stats.csv', usecols=['pgs_id', 'position', 'goalie', 'goals_hudl', 'points_hudl', 'penalties', 'pim_seconds', 'corsi_for', 'corsi_against',
                                               'fenwick_for', 'fenwick_against', 'xg_hudl', 'xg_on_ice_for', 'xg_on_ice_against'])
pgs = pgs.merge(det, left_on='id', right_on='pgs_id', how='left').drop(columns=['pgs_id']).merge(hs, left_on='id', right_on='pgs_id', how='left')
pgs = pgs[pgs.toi_seconds.fillna(0) > 0].copy()
pgs['team_name'] = pgs.team_id.map(TEAM)
_sid = dict(zip(hg.id, hg.source_record_id.astype(str)))
_n2 = len(pgs); pgs = pgs[[(_sid.get(g), t) not in HUDL_EXCL for g, t in zip(pgs.game_id, pgs.team_name)]].copy()
print('excluded %d Hudl player-game row(s) (one side of a game) listed in hub_game_exclusions.json' % (_n2 - len(pgs)))
# one SIDE of a Hudl match filed under the wrong team (hub_game_exclusions.json 'hudl_relabel': {hudl_id, team, as}); applied at once, so two entries can swap a game's sides
_xr = json.load(open(_xp, encoding='utf-8')).get('hudl_relabel', []) if os.path.exists(_xp) else []
if _xr:
    _RL = {(str(g['hudl_id']), g['team']): g['as'] for g in _xr}
    _nm = [_RL.get((_sid.get(g), t), t) for g, t in zip(pgs.game_id, pgs.team_name)]
    print('relabeled %d Hudl player-game row(s) (hub_game_exclusions.json hudl_relabel)' % sum(1 for a_, b_ in zip(_nm, pgs.team_name) if a_ != b_))
    pgs['team_name'] = _nm
pgs['date'] = pgs.game_id.map(dict(zip(hg.id, hg.game_date.astype(str))))
pgs['season'] = pgs.game_id.map(dict(zip(hg.id, hg.season_id))).map(SEASON)
print('Hudl player-games (toi>0):', len(pgs), 'games', pgs.game_id.nunique())

# personkeys with the real makePersonKey
pl = rd('player.csv', usecols=['id', 'first_name', 'last_name']); pl = pl[pl.id.isin(pgs.player_id.unique())]
tmp = os.path.join(tempfile.gettempdir(), 'hub_hudl_pk_%d.json' % os.getpid())
json.dump([{'id': i, 'n': f"{a if isinstance(a, str) else ''} {b if isinstance(b, str) else ''}".strip()} for i, a, b in zip(pl.id, pl.first_name, pl.last_name)], open(tmp, 'w'))
js = r"""
const fs=require('fs'),path=require('path');
const RC=require(path.join(process.argv[1],'tools/rosterClean.js'));
RC.setNameMaps(JSON.parse(fs.readFileSync(path.join(process.argv[1],'firstNameMap.json'),'utf8')));
const a=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const p of a) p.pk=RC.makePersonKey(p.n);
fs.writeFileSync(process.argv[2],JSON.stringify(a));
"""
subprocess.run(['node', '-e', js, TSD, tmp], check=True)
pkd = {x['id']: (x['pk'], x['n']) for x in json.load(open(tmp))}
try: os.remove(tmp)
except OSError: pass
pgs['pk'] = pgs.player_id.map(lambda i: pkd[i][0]); pgs['hname'] = pgs.player_id.map(lambda i: pkd[i][1])
PH = re.compile(r"\d|\bU\d{2}\b|\b(Academy|School|Elite|Hockey|Club|Prep|Jr|Junior|Team|Rebels|Hawks|Bay|Fury|Impact)\b", re.I)
bad = pgs.hname.map(lambda n: bool(PH.search(n))) | pgs.pk.map(lambda k: k.startswith('|') or k.endswith('|') or k == '' or k == 'noname|noname')
print('Hudl placeholder rows dropped:', int(bad.sum())); pgs = pgs[~bad].copy()
pgs['pos'] = pgs.position.where(pgs.position.isin(['F', 'D', 'G']), '?')
pgs.loc[pgs.goalie.fillna(0).astype(float) > 0, 'pos'] = 'G'
pgs = pgs[pgs.team_name.notna()]
for _c in ('shifts', 'pp_toi_seconds', 'pk_toi_seconds'): pgs[_c] = pgs[_c].fillna(0)

# ---------- Hudl team name -> TPE team name, learned from games both platforms hold (same players on the ice) ----------
tpe_pks = collections.defaultdict(dict)                   # tpe gi -> {team: set(pk)}
for (gi, tn), lst in tpe_rows.items(): tpe_pks[gi][tn] = {x[0] for x in lst}
votes = collections.defaultdict(collections.Counter)
for g, grp in pgs.groupby('game_id'):
    t = PAIR.get(g)
    if t not in tpe_gid or tpe_gid[t] not in tpe_pks: continue
    for hn, hgrp in grp.groupby('team_name'):
        hset = set(hgrp.pk)
        best = max(tpe_pks[tpe_gid[t]].items(), key=lambda kv: len(kv[1] & hset), default=None)
        if best and len(best[1] & hset) >= 5: votes[hn][best[0]] += 1
ALIAS = {hn: c.most_common(1)[0][0] for hn, c in votes.items()}
print('Hudl team names linked to a TPE team:', len(ALIAS), '|', sum(1 for h, t in ALIAS.items() if h != t), 'differ in spelling')
pgs['team_name'] = pgs.team_name.map(lambda n: ALIAS.get(n, n))

# ---------- hand-captured Hudl games (hub_extras/hudl_*.txt, see tools/hudl_extras.py): appended on every build, the export wins when it holds the same Hudl match ----------
sys.path.insert(0, os.path.join(TSD, 'tools')); import hudl_extras, datetime
EXREAL = {}; EXDATE = {}; XMAP = {}       # XMAP: (real game, Hudl team name) -> TPE team name of the same side, so coverage masks line up when the two platforms spell a team differently
_xr, _xg = hudl_extras.load(os.path.join(TSD, 'hub_extras'), HAVE_H)
_starts = sorted(WSTART.items(), key=lambda kv: kv[1])
def _season_of(d):
    ok = [n for n, st in _starts if d >= st]
    return ok[-1] if ok else None
if _xr:
    ex = pd.DataFrame(_xr); ex['season'] = ex.date.map(_season_of)
    _drop = ex[ex.season.isna()].hid.nunique(); ex = ex[ex.season.notna()].copy()
    ex = ex[ex.toi_seconds > 0].copy()
    _t = os.path.join(tempfile.gettempdir(), 'hub_hudl_xpk_%d.json' % os.getpid())
    json.dump([{'id': i, 'n': n} for i, n in enumerate(sorted(ex.name.unique()))], open(_t, 'w')); subprocess.run(['node', '-e', js, TSD, _t], check=True)
    _pk = {x['n']: x['pk'] for x in json.load(open(_t))}; os.remove(_t)
    ex['pk'] = ex.name.map(_pk); ex['hname'] = ex.name
    ex = ex[~(ex.hname.map(lambda n: bool(PH.search(n))) | ex.pk.map(lambda k: k.startswith('|') or k.endswith('|') or k == '' or k == 'noname|noname'))].copy()
    ex['game_id'] = 'hx' + ex.hid
    # team names: first the TPE game on that date (+-1 day) with the most shared players, else the Hudl team (any date) with the most shared players
    tpe_by_date = collections.defaultdict(list)
    for gi, r in enumerate(GROW): tpe_by_date[r[1]].append(gi)
    hud_sets = collections.defaultdict(set)
    for tn, k in zip(pgs.team_name, pgs.pk): hud_sets[tn].add(k)
    _paired = 0; amap = {}
    for hid, g in ex.groupby('hid'):
        d0 = datetime.date.fromisoformat(g.date.iloc[0]); sets = {tn: set(x.pk[x.pos != 'G']) for tn, x in g.groupby('team')}
        best = None
        for dd in (0, -1, 1):
            for gi in tpe_by_date.get((d0 + datetime.timedelta(days=dd)).isoformat(), []):
                if gi not in tpe_pks: continue
                sc = sum(max([len(v & st) for v in tpe_pks[gi].values()] + [0]) for st in sets.values())
                if sc >= 5 and (best is None or sc > best[0]): best = (sc, gi)
        for tn, st in sets.items():     # the Hudl-side name: the Hudl team (any date) sharing the most players, else this capture's own name
            t2 = max(hud_sets.items(), key=lambda kv: len(kv[1] & st), default=None)
            amap[(hid, tn)] = t2[0] if t2 and len(t2[1] & st) >= 5 else ALIAS.get(tn, tn)
        if best:
            gi = best[1]; EXREAL['hx' + hid] = ('t', gi); _paired += 1
            for tn, st in sets.items():
                t2 = max(tpe_pks[gi].items(), key=lambda kv: len(kv[1] & st))
                if len(t2[1] & st) >= 5 and t2[0] != amap[(hid, tn)]: XMAP[(('t', gi), amap[(hid, tn)])] = t2[0]
    ex['team_name'] = [amap.get((h, t), t) for h, t in zip(ex.hid, ex.team)]
    ex['pos'] = ex.pos.where(ex.pos.isin(['F', 'D', 'G']), '?')
    for h, dte in zip(ex.hid, ex.date): EXDATE['hx' + h] = dte
    pgs = pd.concat([pgs, ex[[c for c in ex.columns if c in pgs.columns or c in ('hname', 'pk')]]], ignore_index=True)
    print('hub_extras Hudl: %d game(s), %d player-games added (%d paired to a TPE game, %d before the season window)' % (ex.hid.nunique(), len(ex), _paired, _drop))
    for k, v in sorted({(h, t): n for (h, t), n in amap.items()}.items()): print('   hudl %s  %-34s -> %s' % (k[0], k[1], v))

# ---------- one real game per (game, team): Hudl games paired to TPE take the TPE game's identity; others dedupe on date + teams ----------
gteams = pgs.groupby('game_id').team_name.apply(lambda s: frozenset(s.unique()))
gdate = dict(zip(hg.id, hg.game_date.astype(str))); gdate.update(EXDATE)
real = {}
for g in sorted(pgs.game_id.unique()):
    t = PAIR.get(g)
    real[g] = EXREAL[g] if g in EXREAL else ('t', tpe_gid[t]) if t in tpe_gid else ('h', gdate[g], gteams[g])
pgs['real'] = pgs.game_id.map(real)
# keep the first Hudl game (by id) per (real game, team)
first = pgs.groupby(['real', 'team_name']).game_id.transform('min')
dups = int((pgs.game_id != first).sum()); pgs = pgs[pgs.game_id == first].copy()
print('Hudl duplicate team-game rows removed:', dups)

# ---------- coverage + merged TOI rows ----------
cov = collections.defaultdict(int)                        # (real, team) -> mask
for (gi, tn) in tpe_rows: cov[(('t', gi), tn)] |= 1
for r, tn in pgs[['real', 'team_name']].drop_duplicates().itertuples(index=False): cov[(r, XMAP.get((r, tn), tn))] |= 2
agg = collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0, 0, 0, 0.0, 0.0, 0]); gagg = collections.defaultdict(lambda: [0, 0, 0, 0, 0]); name_of = {}; counts = collections.defaultdict(lambda: [0, 0])
TI = {t: i for i, t in enumerate(TEAMS)}
extra_teams = []
def ti_of(tn):
    if tn not in TI: TI[tn] = len(TEAMS) + len(extra_teams); extra_teams.append(tn)
    return TI[tn]
for (gi, tn), lst in tpe_rows.items():
    si = tpe_season[gi]; m = cov[(('t', gi), tn)]; ti = ti_of(tn)
    counts[(ti, si)][0] += 1
    for pk, pos, toi, sh, pp, pkk, gl, asst, sog, xf, xa in lst:
        a = agg[(ti, si, pk, 0, m, pos)]; a[0] += 1; a[1] += toi; a[2] += sh; a[3] += pp; a[4] += pkk; a[5] += gl; a[6] += asst; a[7] += sog
        if xf is not None and xa is not None: a[8] += xf; a[9] += xa; a[10] += 1      # on-ice expected goals for/against (TPE model); a[10] = games that carry it
        name_of.setdefault(pk, PNAME.get(pk))
for (gi, tn), lst in tpe_g.items():       # TPE goalies: [gp, toi, shots against, goals against, toi in games that carry shot data]
    si = tpe_season[gi]; m = cov.get((('t', gi), tn), 1); ti = ti_of(tn)
    for pk, toi, sa, ga in lst:
        a = gagg[(ti, si, pk, 0, m)]; a[0] += 1; a[1] += toi
        if sa > 0: a[2] += sa; a[3] += ga; a[4] += toi
        name_of.setdefault(pk, PNAME.get(pk))
pgs['si'] = pgs.season.map(SI)
_n = lambda v: int(v) if v == v and v is not None else 0      # NaN-safe int
sk = pgs[pgs.pos != 'G']
tg = sk.groupby(['real', 'team_name'])
for (r, tn), grp in tg:
    m = cov[(r, XMAP.get((r, tn), tn))]; ti = ti_of(tn); si = int(grp.si.iloc[0])
    for row in grp.itertuples(index=False):
        a = agg[(ti, si, row.pk, 1, m, row.pos)]; a[0] += 1; a[1] += int(row.toi_seconds); a[2] += int(row.shifts or 0)
        a[3] += int(row.pp_toi_seconds or 0); a[4] += int(row.pk_toi_seconds or 0)
        _gl = _n(row.goals_hudl); _pt = _n(row.points_hudl); a[5] += _gl; a[6] += max(0, _pt - _gl); a[7] += _n(row.shots_on_goal)
        _xf = getattr(row, 'xg_on_ice_for', None); _xa = getattr(row, 'xg_on_ice_against', None)      # Hudl's own on-ice xG
        if _xf == _xf and _xa == _xa and _xf is not None and _xa is not None: a[8] += float(_xf); a[9] += float(_xa); a[10] += 1
        name_of.setdefault(row.pk, row.hname)
_opp = collections.defaultdict(lambda: [0, 0])          # (real game, team) -> [shots on goal, goals] by that side's skaters
for row in sk.itertuples(index=False):
    o = _opp[(row.real, row.team_name)]; o[0] += _n(row.shots_on_goal); o[1] += _n(row.goals_hudl)
_sides = collections.defaultdict(list)
for r_, tn_ in pgs[['real', 'team_name']].drop_duplicates().itertuples(index=False): _sides[r_].append(tn_)
for row in pgs[pgs.pos == 'G'].itertuples(index=False):
    tn = row.team_name; m = cov[(row.real, XMAP.get((row.real, tn), tn))]; ti = ti_of(tn); si = int(row.si)
    sa = ga = 0
    for ot in _sides[row.real]:
        if ot != tn: sa += _opp[(row.real, ot)][0]; ga += _opp[(row.real, ot)][1]
    a = gagg[(ti, si, row.pk, 1, m)]; a[0] += 1; a[1] += int(row.toi_seconds)
    if sa > 0: a[2] += sa; a[3] += ga; a[4] += int(row.toi_seconds)
    name_of.setdefault(row.pk, row.hname)
hud_tg = pgs.drop_duplicates(['real', 'team_name'])[['real', 'team_name', 'si']]
for r, tn, si in hud_tg.itertuples(index=False): counts[(ti_of(tn), int(si))][1] += 1

master = json.load(open(os.path.join(TSD, 'master.json'))); M = {x['PersonKey']: x for x in master}
rows = [[ti, si, pk, (M[pk]['Name'] if pk in M else name_of.get(pk) or pk), pos, src, m, *(a[:8] + [round(a[8], 2), round(a[9], 2), a[10]])] for (ti, si, pk, src, m, pos), a in sorted(agg.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2], kv[0][3], kv[0][4]))]
grows = [[ti, si, pk, (M[pk]['Name'] if pk in M else name_of.get(pk) or pk), src, m, *a] for (ti, si, pk, src, m), a in sorted(gagg.items(), key=lambda kv: kv[0])]
obj = {'header': ['ti', 'si', 'pk', 'name', 'pos', 'src', 'mask', 'gp', 'toi', 'shifts', 'pp', 'pk_', 'goals', 'assists', 'sog', 'xgf', 'xga', 'xgn'], 'sources': ['tpe', 'hudl'],
       'goalie_header': ['ti', 'si', 'pk', 'name', 'src', 'mask', 'gp', 'toi', 'sa', 'ga', 'toi_d'], 'goalies': grows,
       'teams': TEAMS + extra_teams, 'seasons': SEAS, 'games': {'%d|%d' % k: v for k, v in counts.items()}, 'rows': rows}
p = os.path.join(OUT, 'hub_toi.json'); json.dump(obj, open(p, 'w'), separators=(',', ':'))
# small per-team Hudl team-game counts for the Teams > TPE "Data Available" view (TPE / Hudl): {"si|TPE team name": n}.
# A Hudl team name is linked to the TPE team (same season) sharing the most skaters (>=5 and >=half of the Hudl side's skaters), so the
# count lands on the TPE-named row even where Hudl spells / splits the team differently; unlinked Hudl teams keep their own name.
_TN = TEAMS + extra_teams
_tpl = collections.defaultdict(set)
for (gi_, tn_), lst_ in tpe_rows.items(): _tpl[(tpe_season[gi_], tn_)] |= {x[0] for x in lst_}
_hdl = collections.defaultdict(set)
for tn_, si_, pk_ in zip(sk.team_name, sk.si, sk.pk): _hdl[(int(si_), tn_)].add(pk_)
_by_si = collections.defaultdict(list)
for (s2_, n_), v_ in _tpl.items(): _by_si[s2_].append((n_, v_))
_link = {}
for (si_, hn_), hs_ in _hdl.items():
    if (si_, hn_) in _tpl: _link[(si_, hn_)] = hn_; continue
    bn_, bc_ = max(((n_, len(v_ & hs_)) for n_, v_ in _by_si[si_]), key=lambda x: x[1], default=(None, 0))
    _link[(si_, hn_)] = bn_ if bc_ >= 5 and bc_ >= 0.5 * len(hs_) else hn_
_srcg = collections.Counter()
for (ti_, si_), v_ in counts.items():
    if v_[1]: nm_ = _TN[ti_]; _srcg['%d|%s' % (si_, _link.get((si_, nm_), nm_))] += v_[1]
json.dump({'note': 'Hudl team-games per season|TPE-linked team (a game counts once for each side; games paired with a TPE game included). Built by build_hub_hudl.py.',
           'hudl': dict(_srcg)}, open(os.path.join(OUT, 'hub_srcgames.json'), 'w'), separators=(',', ':'))
print('hub_srcgames.json written')
print('hub_toi.json: %d rows, %.2f MiB, %d extra teams (Hudl only)' % (len(rows), os.path.getsize(p) / 1048576, len(extra_teams)))

# ---------- full Hudl data per player-team-season ----------
S = ['toi_seconds', 'shifts', 'pp_toi_seconds', 'pk_toi_seconds', 'shots_on_goal', 'shot_attempts', 'shots_missed_net', 'blocked_shots', 'plus_minus',
     'faceoffs_won', 'faceoffs_lost', 'goals_hudl', 'points_hudl', 'penalties', 'pim_seconds', 'corsi_for', 'corsi_against', 'fenwick_for',
     'fenwick_against', 'xg_hudl', 'xg_on_ice_for', 'xg_on_ice_against']
ps = pgs.copy(); ps['ti'] = ps.team_name.map(ti_of)
g = ps.groupby(['pk', 'si', 'ti'], as_index=False).agg(gp=('game_id', 'nunique'), pos=('pos', lambda s: s[s != '?'].value_counts().index[0] if (s != '?').any() else '?'),
                                                       hname=('hname', 'first'), **{c: (c, 'sum') for c in S})
def cl(v):
    if v is None or (isinstance(v, float) and np.isnan(v)): return None
    f = round(float(v), 3); return int(f) if f == int(f) else f
hr = [[r.pk, (M[r.pk]['Name'] if r.pk in M else r.hname), int(r.si), int(r.ti), r.pos, int(r.gp)] + [cl(getattr(r, c)) for c in S] for r in g.itertuples(index=False)]
hobj = {'header': ['pk', 'name', 'si', 'ti', 'pos', 'gp'] + S, 'teams': TEAMS + extra_teams, 'seasons': SEAS, 'rows': hr}
p = os.path.join(OUT, 'hub_hudl.json'); json.dump(hobj, open(p, 'w'), separators=(',', ':'))
print('hub_hudl.json: %d rows, %.2f MiB' % (len(hr), os.path.getsize(p) / 1048576))
