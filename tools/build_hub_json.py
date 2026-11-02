#!/usr/bin/env python3
"""Build static JSON for the Hub (TPE) data -> TopShelf pivots/charts.

Inputs : Hub export CSVs (this folder), topshelf-data/master.json, firstNameMap.json, tools/rosterClean.js
Outputs: topshelf-data/hub/  (header+rows shape, personkey-keyed, TPE games only; Hudl is never mixed in)
Usage  : python3 build_hub_json.py [EXPORT_DIR] [TOPSHELF_DATA_DIR] [OUT_DIR]
"""
import sys, os, json, re, subprocess, collections, datetime
import pandas as pd
import numpy as np

HOME = os.path.expanduser('~')
EXP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, 'mnt/Hub Export 2026-10-31')
TSD = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HOME, 'mnt/topshelf-data')
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(TSD, 'hub')
os.makedirs(OUT, exist_ok=True)
rd = lambda f, **k: pd.read_csv(os.path.join(EXP, f), low_memory=False, **k)

# ---------- dimensions ----------
season = rd('season.csv')
SEASON = dict(zip(season.id, season.name))
game = rd('game.csv')
tpe = game[(game.source_system == 'tpe') & game.superseded_by_game_id.isna()].copy()
team = rd('team.csv'); ident = rd('team_identity.csv')
IDN = dict(zip(ident.id, ident.name))
TEAM = {i: (IDN[idn] if isinstance(idn, str) and idn in IDN else nm)
        for i, idn, nm in zip(team.id, team.identity_id, team.name)}
univ = rd('game_universe.csv')
U = univ.set_index('game_id')

# ---------- player stats (TPE only) ----------
PGS = ['id', 'game_id', 'player_id', 'team_id', 'is_opponent', 'toi_seconds', 'shifts', 'goals', 'assists',
       'primary_assists', 'secondary_assists', 'shots_on_goal', 'shot_attempts', 'blocked_shots', 'scoring_chances',
       'danger_shot_attempts', 'plus_minus', 'passes_successful', 'passes_unsuccessful', 'key_passes',
       'avg_possession_seconds', 'total_possession_seconds', 'oz_possession_seconds', 'nz_possession_seconds',
       'dz_possession_seconds', 'true_total_possessions', 'recoveries', 'giveaways',
       'tpe_entries_successful_controlled', 'tpe_entries_successful_uncontrolled', 'tpe_entries_failed_controlled',
       'tpe_entries_failed_uncontrolled', 'tpe_exits_successful_controlled', 'tpe_exits_successful_uncontrolled',
       'tpe_exits_failed_controlled', 'tpe_exits_failed_uncontrolled', 'on_ice_goals_for', 'on_ice_goals_against',
       'danger_shots_on_goal', 'entries_carry_in', 'exits_carry_out', 'on_ice_shots_for', 'on_ice_shots_against',
       'passes_successful_dz', 'passes_unsuccessful_dz',
       'on_ice_xg_for', 'on_ice_xg_against']
DET = ['pgs_id', 'takeaways', 'xg', 'xa', 'faceoffs_won', 'faceoffs_lost', 'pp_toi_seconds', 'pk_toi_seconds',
       'saves', 'shots_against', 'goals_against']
pgs = rd('player_game_stats.csv', usecols=PGS)
pgs = pgs[pgs.game_id.isin(tpe.id)]
det = rd('player_game_stats_detail.csv', usecols=DET)
pgs = pgs.merge(det, left_on='id', right_on='pgs_id', how='left').drop(columns=['pgs_id'])
pgs = pgs[pgs.toi_seconds.fillna(0) > 0]
ros = rd('game_roster_entry.csv', usecols=['game_id', 'player_id', 'position'])
ros = ros.dropna(subset=['position']).drop_duplicates(['game_id', 'player_id'])
pgs = pgs.merge(ros, on=['game_id', 'player_id'], how='left')
print('TPE player-games (toi>0):', len(pgs), 'games', pgs.game_id.nunique())

# ---------- personkey via the real makePersonKey ----------
pl = rd('player.csv', usecols=['id', 'first_name', 'last_name'])
pl = pl[pl.id.isin(pgs.player_id.unique())].copy()
import tempfile
tmp = os.path.join(tempfile.gettempdir(), 'hub_pk_in_%d.json' % os.getpid())
json.dump([{'id': i, 'n': f"{(a if isinstance(a, str) else '')} {(b if isinstance(b, str) else '')}".strip()}
           for i, a, b in zip(pl.id, pl.first_name, pl.last_name)], open(tmp, 'w'))
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
pgs['pk'] = pgs.player_id.map(lambda i: pkd[i][0])
pgs['hname'] = pgs.player_id.map(lambda i: pkd[i][1])

# placeholders: "player" rows whose name is really a team label / has digits
PH = re.compile(r"\d|\bU\d{2}\b|\b(Academy|School|Elite|Hockey|Club|Prep|Jr|Junior|Team|Rebels|Hawks|Bay|Fury|Impact)\b", re.I)
isph = pgs.hname.map(lambda n: bool(PH.search(n)))
pgs['ph'] = isph | pgs.pk.map(lambda k: k.startswith('|') or k.endswith('|') or k == '')
ph_rows = pgs[pgs.ph]
ph_rows.groupby('hname').size().sort_values(ascending=False).to_csv(os.path.join(OUT, 'placeholders_dropped.csv'), header=['rows'])
print('placeholder rows dropped:', len(ph_rows), 'names', ph_rows.hname.nunique())
pgs = pgs[~pgs.ph].copy()

# ---------- master (source of truth for names) ----------
master = json.load(open(os.path.join(TSD, 'master.json')))
M = {r['PersonKey']: r for r in master}
pgs['inm'] = pgs.pk.isin(M.keys())

# ---------- team / season / game indexes ----------
pgs['gseason'] = pgs.game_id.map(dict(zip(tpe.id, tpe.season_id))).map(SEASON)
pgs['team_name'] = pgs.team_id.map(TEAM)
# opponent rows may lack a team_id -> use the game's opponent name from the universe
gopp = {gid: (U.at[gid, 'opponent'] if gid in U.index else None) for gid in pgs.game_id.unique()}
gtrk = {gid: (U.at[gid, 'tracked_team'] if gid in U.index else None) for gid in pgs.game_id.unique()}
miss = pgs.team_name.isna()
pgs.loc[miss, 'team_name'] = [gopp.get(g) if o else gtrk.get(g) for g, o in zip(pgs.game_id[miss], pgs.is_opponent[miss])]
print('rows still without team name:', pgs.team_name.isna().sum())
pgs['team_name'] = pgs.team_name.fillna('?')

# one row per (game, pk, team): sum if a person appears twice in a game
key = ['game_id', 'pk', 'team_name']
dup = pgs.duplicated(key, keep=False).sum()
print('duplicate (game,person,team) rows:', dup)

NUM = [c for c in PGS + DET if c not in ('id', 'game_id', 'player_id', 'team_id', 'is_opponent', 'pgs_id',
                                         'avg_possession_seconds')]
agg = {c: 'sum' for c in NUM}
agg['avg_possession_seconds'] = 'mean'; agg['position'] = 'first'; agg['is_opponent'] = 'max'
agg['gseason'] = 'first'; agg['hname'] = 'first'
pg = pgs.groupby(key, as_index=False).agg(agg)
pg['pos'] = pg.position.fillna('?')

# ---------- dictionaries ----------
teams = sorted(pg.team_name.unique()); TI = {t: i for i, t in enumerate(teams)}
seasons = sorted(SEASON.values()); SI = {s: i for i, s in enumerate(seasons)}
gids = sorted(pg.game_id.unique(), key=lambda g: (str(U.at[g, 'game_date']) if g in U.index else '', g)); GI = {g: i for i, g in enumerate(gids)}
people = pg.groupby('pk').agg(hname=('hname', lambda s: s.value_counts().index[0]),
                              gp=('game_id', 'nunique'), pos=('pos', lambda s: s[s != '?'].value_counts().index[0] if (s != '?').any() else '?'),
                              seasons=('gseason', lambda s: sorted(set(s)))).reset_index().sort_values('pk')
PI = {k: i for i, k in enumerate(people.pk)}

def clean(v):
    if v is None or (isinstance(v, float) and np.isnan(v)): return None
    if isinstance(v, (np.integer,)): return int(v)
    if isinstance(v, (np.floating, float)):
        f = round(float(v), 3)
        return int(f) if f == int(f) else f
    return v

def dump(name, header, rows, meta=None):
    obj = {'header': header, 'rows': rows}
    if meta: obj['meta'] = meta
    p = os.path.join(OUT, name)
    json.dump(obj, open(p, 'w'), separators=(',', ':'))
    print(f'{name}: {len(rows):,} rows, {os.path.getsize(p)/1048576:.2f} MiB')

# ---------- players ----------
prow = []
for r in people.itertuples():
    m = M.get(r.pk)
    prow.append([r.pk, (m['Name'] if m else r.hname), 1 if m else 0, r.pos, int(r.gp), [SI[s] for s in r.seasons]])
dump('hub_players.json', ['pk', 'name', 'inMaster', 'pos', 'gp', 'seasons'], prow)

# ---------- games ----------
grow = []
GC = ['game_date', 'season', 'tracked_team', 'opponent', 'score_for', 'score_against', 'result', 'overtime',
      'age_bracket', 'event_type', 'league_family', 'country_guess', 'competition_label', 'tracked_in_topshelf']
for g in gids:
    u = U.loc[g] if g in U.index else None
    row = [g]
    for c in GC:
        v = u[c] if u is not None else None
        if c == 'season': v = SI.get(v)
        if c == 'overtime': v = 1 if v is True or v == True else 0
        row.append(clean(v) if not isinstance(v, str) else v)
    grow.append(row)
dump('hub_games.json', ['gid'] + GC, grow)

# ---------- player-game (per season) ----------
PG_COLS = ['gi', 'pi', 'ti', 'pos', 'opp'] + NUM + ['avg_possession_seconds']
for s in seasons:
    d = pg[pg.gseason == s]
    if d.empty: continue
    rows = []
    for r in d.itertuples(index=False):
        rr = r._asdict()
        rows.append([GI[rr['game_id']], PI[rr['pk']], TI[rr['team_name']], rr['pos'], 1 if rr['is_opponent'] else 0] +
                    [clean(rr[c]) for c in NUM] + [clean(rr['avg_possession_seconds'])])
    dump(f'hub_pgs_{s.replace(chr(0x2013), "-")}.json', PG_COLS, rows)

# ---------- player-season (sums; ratios are computed client-side) ----------
sumcols = NUM
ps = pg.groupby(['pk', 'gseason', 'team_name'], as_index=False).agg(
    gp=('game_id', 'nunique'), pos=('pos', lambda s: s[s != '?'].value_counts().index[0] if (s != '?').any() else '?'),
    avgposs=('avg_possession_seconds', 'mean'), **{c: (c, 'sum') for c in sumcols})
rows = [[PI[r.pk], SI[r.gseason], TI[r.team_name], r.pos, int(r.gp)] + [clean(getattr(r, c)) for c in sumcols] + [clean(r.avgposs)]
        for r in ps.itertuples(index=False)]
dump('hub_player_seasons.json', ['pi', 'si', 'ti', 'pos', 'gp'] + sumcols + ['avg_possession_seconds_mean'], rows)


# ---------- MHR team ranks (for the "top N teams" comparators) ----------
STOP = {'w','aa','a','aaa','t1','t2','tier','tier1','tier2','major','major1','girls','womens','women','jr','junior',
        'hockey','club','team','the','prep','prepw','ice','hc','ha','association','u','elite','school','academy'}
def mnorm(n):
    n = re.sub(r'\s*\([A-Z]{2}\)\s*$', '', str(n).strip())
    n = re.sub(r'\(#?\d+\)', '', n)
    n = re.sub(r'\((tier\s?\d|major\s?\d?|t\d)\)', '', n, flags=re.I)
    n = re.sub(r'\bU\s?\d{2}\b|\b\d{2}\s?U\b', ' ', n.replace('(', ' ').replace(')', ' ').replace('-', ' '), flags=re.I)
    n = re.sub(r"[^a-z0-9 ]", '', n.lower().replace('&', ' and '))
    return frozenset(w for w in n.split() if w not in STOP)
def hub_level(nm):
    m = re.search(r'\bU\s?(\d{2})\b|\b(\d{2})\s?U\b', nm, re.I)
    if not m: return None
    return {16: 'USA 16U', 19: 'USA 19U', 18: 'Canada U18', 22: 'Canada U22', 14: 'USA 14U', 15: 'Canada U15'}.get(int(m.group(1) or m.group(2)))
cur = json.load(open(os.path.join(TSD, 'mhr_current.json'))); his = json.load(open(os.path.join(TSD, 'mhr_history.json')))
MR = collections.defaultdict(list)   # (level, season) -> [(rank, name, tokens)]
for lv, s_, rk, nm, *_ in his['rows']: MR[(lv, s_)].append((rk, nm, mnorm(nm)))
for lv, rk, nm, *_ in cur['rows']: MR[(lv, cur['season'])].append((rk, nm, mnorm(nm)))
alias_p = os.path.join(OUT, 'hub_team_aliases.json')
ALIAS = json.load(open(alias_p)) if os.path.exists(alias_p) else {}   # {"Hub team name": "exact MHR team name"}
used_ts = pg.groupby(['team_name', 'gseason']).game_id.nunique().to_dict()
rank_rows = []; unmatched = []
for (tn, sn), ng in used_ts.items():
    lv = hub_level(tn)
    if not lv and tn in ALIAS:
        lv = next((k[0] for k, L in MR.items() if k[1] == sn.replace(chr(0x2013), '-') and any(nm == ALIAS[tn] for _, nm, _ in L)), None)
    if not lv: continue
    cands = MR.get((lv, sn.replace(chr(0x2013), '-')), [])
    if not cands: continue
    best = None
    if tn in ALIAS:
        best = next(((rk, nm) for rk, nm, _ in cands if nm == ALIAS[tn]), None)
    if best is None:
        th = mnorm(tn)
        if not th: continue
        sc = []
        for rk, nm, tm in cands:
            if not tm: continue
            inter = len(th & tm)
            if inter == 0: continue
            jac = inter / len(th | tm)
            sub = th <= tm or tm <= th
            if jac >= 0.99 or (sub and inter >= 1 and jac >= 0.5) or jac >= 0.75: sc.append((jac, -rk, rk, nm))
        if sc:
            sc.sort(reverse=True)
            if len(sc) > 1 and sc[0][0] == sc[1][0] and sc[0][3] != sc[1][3]:
                unmatched.append((lv, sn, tn, ng, 'ambiguous: ' + sc[0][3] + ' / ' + sc[1][3])); continue
            best = (sc[0][2], sc[0][3])
    if best: rank_rows.append([TI[tn], SI[sn], lv, best[0], best[1]])
    else: unmatched.append((lv, sn, tn, ng, ''))
dump('hub_team_rank.json', ['ti', 'si', 'level', 'rank', 'mhr_name'], rank_rows)
# which top-25 MHR teams found no Hub team-season (reviewable; fix via hub/hub_team_aliases.json)
hit = {(r[2], teams_season, r[3]) for r in rank_rows for teams_season in [seasons[r[1]].replace(chr(0x2013), '-')]}
miss = [(lv, s_, rk, nm) for (lv, s_), L in MR.items() for rk, nm, _ in L
        if rk <= 25 and (lv, s_, rk) not in hit and s_ in [x.replace(chr(0x2013), '-') for x in seasons]
        and lv in ('USA 16U', 'USA 19U', 'Canada U18', 'Canada U22')]
pd.DataFrame(miss, columns=['level', 'season', 'rank', 'mhr_name']).sort_values(['level', 'season', 'rank']).to_csv(os.path.join(OUT, 'mhr_top25_without_hub_team.csv'), index=False)
pd.DataFrame(unmatched, columns=['level', 'season', 'hub_team', 'games', 'note']).sort_values('games', ascending=False).to_csv(os.path.join(OUT, 'hub_teams_without_mhr.csv'), index=False)
print('rank rows', len(rank_rows), '| top-25 MHR teams with no Hub team-season:', len(miss))

# ---------- meta ----------
json.dump({'built': datetime.datetime.utcnow().isoformat() + 'Z', 'source': os.path.basename(EXP.rstrip('/')),
           'seasons': seasons, 'teams': teams,
           'notes': 'TPE games only (Hudl never mixed). Index columns: gi->hub_games rows, pi->hub_players rows, ti->teams, si->seasons. '
                    'Ratios (pass accuracy etc.) are not stored; compute from sums. placeholders dropped: %d rows.' % len(ph_rows)},
          open(os.path.join(OUT, 'hub_meta.json'), 'w'), separators=(',', ':'))
print('done')
