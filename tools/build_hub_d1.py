#!/usr/bin/env python3
"""build_hub_d1.py -- builds hub/hub_d1.json for the "D1 commits" tab on tpe.html.
One row per matched player (best season: most games, at least 5 on one team), with the outcome group
(none / D3-other / D1 tier 4..1), grad class, level and TPE metrics in three lenses: raw, level-adjusted z
(within season x level x position) and relative-to-teammates z. Reads master.json, commits.json, commits_d3.json, d1.json, hub/*.json.
Usage: python3 tools/build_hub_d1.py [REPO_DIR]"""
import json, re, os, sys, datetime
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import d1_metrics as dm
R = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda p: json.load(open(os.path.join(R, p), encoding='utf-8'))
master = {r['PersonKey']: r for r in J('master.json')}
commits = {r['personkey']: r for r in J('commits.json')}
d3 = {r['personkey']: r for r in J('commits_d3.json')}
d1 = J('d1.json'); d1tier = {k: int(v['tier']) for k, v in d1.items()}
norm = lambda s: re.sub(r'[^a-z]', '', (s or '').lower()); d1n = {norm(k): k for k in d1}
meta = J('hub/hub_meta.json'); hp = J('hub/hub_players.json'); ps = J('hub/hub_player_seasons.json')
P = pd.DataFrame(hp['rows'], columns=hp['header']); S = pd.DataFrame(ps['rows'], columns=ps['header'])
S['season'] = S.si.map(lambda i: meta['seasons'][i]); S['team'] = S.ti.map(lambda i: meta['teams'][i])
S['pk'] = S.pi.map(P.pk); S['hubpos'] = S.pi.map(P.pos)
def level(t):
    mm = re.search(r'U\s?(\d\d)|(\d\d)\s?U', str(t))
    if not mm: return 3
    n = int(mm.group(1) or mm.group(2)); return 0 if n in (14, 15) else 1 if n in (16, 17, 18) else 2 if n in (19, 22) else 3
S['lvl'] = S.team.map(level)
S5 = S[S.gp >= 5].copy(); S5['tpos'] = S5['pos']
GROUPS = ['none', 'D3/other', 'T4', 'T3', 'T2', 'T1']
def outcome(pk):
    c = commits.get(pk)
    if c:
        t = str(c.get('Tier')).strip(); col = c.get('College')
        t = int(t) if t in ('1', '2', '3', '4') else d1tier.get(d1n.get(norm(col)))
        return ('T%d' % t) if t else None
    col = master.get(pk, {}).get('College')
    if col and norm(col) in d1n: return 'T%d' % d1tier[d1n[norm(col)]]
    if pk in d3 or col: return 'D3/other'
    return 'none'
# metrics (all rows, for the reference populations)
MF = dm.metrics(S5); MG = dm.goalie_metrics(S5)
def zlens(M):
    key = S5[['season', 'lvl', 'tpos']].astype(str).agg('|'.join, axis=1); tk = S5[['season', 'ti', 'tpos']].astype(str).agg('|'.join, axis=1)
    Z = pd.DataFrame(index=M.index); W = pd.DataFrame(index=M.index)
    for c in M.columns:
        x = M[c]; mu = x.groupby(key).transform('mean'); sd = x.groupby(key).transform('std'); n = x.groupby(key).transform('count')
        Z[c] = np.where(n >= 15, (x - mu) / sd.replace(0, np.nan), np.nan)
        tn = x.groupby(tk).transform('count'); tm = (x.groupby(tk).transform('sum') - x) / (tn - 1).replace(0, np.nan)
        W[c] = np.where((tn >= 5) & (n >= 15), (x - tm) / sd.replace(0, np.nan), np.nan)
    return Z, W
ZF, WF = zlens(MF); ZG, WG = zlens(MG)
best = S5.sort_values(['pk', 'gp', 'si'], ascending=[True, False, False]).groupby('pk').head(1)
def sig(v):
    return None if v is None or v != v else float('%.4g' % v)
# display names (the metric columns keep their internal names; only the label shown on the page changes)
DISPLAY = {'On-ice SA /20': 'Shots against /20', 'On-ice xGA /20': 'xG against /20'}
# schools per D1 tier, for the tooltips on the tier labels
tier_schools = {'T%d' % t: sorted(k for k, v in d1tier.items() if v == t) for t in (1, 2, 3, 4)}
out = {'meta': {'tierSchools': tier_schools, 'built': datetime.date.today().isoformat(), 'groups': GROUPS, 'levels': ['14U/U15', '16U/U18', '19U/U22', 'Other'], 'seasons': meta['seasons'],
        'note': 'TPE only. Best season per player (most games, 5+). Outcome from commits.json (D1 tier via d1.json), D3/other from commits_d3.json or master College.'},
       'metrics': {}, 'rows': {}}
cat = {'F': dm.CAT_F, 'D': dm.CAT_D, 'G': dm.CAT_G}
for pos in ['F', 'D', 'G']:
    out['metrics'][pos] = [{'label': DISPLAY.get(l, l), 'cat': c, 'dir': d, 'ours': o} for l, c, d, o in cat[pos]]
    out['rows'][pos] = []
cnt = {}
for idx, r in best.iterrows():
    pk = r.pk; mr = master.get(pk)
    if not mr: continue
    pos = mr.get('Position') if mr.get('Position') in ('F', 'D', 'G') else r.hubpos
    if pos not in ('F', 'D', 'G'): continue
    grad = mr.get('Grad') or (mr.get('BirthYr') + 18 if mr.get('BirthYr') else None)
    if not grad or not (2024 <= int(grad) <= 2028): continue
    g = outcome(pk)
    if not g: continue
    labels = [m[0] for m in cat[pos]]
    A, B, Cc = (MG, ZG, WG) if pos == 'G' else (MF, ZF, WF)
    raw = [sig(A.at[idx, l]) for l in labels]
    z1 = [None if B.at[idx, l] != B.at[idx, l] else round(float(B.at[idx, l]), 2) for l in labels]
    z2 = [None if Cc.at[idx, l] != Cc.at[idx, l] else round(float(Cc.at[idx, l]), 2) for l in labels]
    out['rows'][pos].append([mr.get('Name') or r.pk, pk, int(grad), GROUPS.index(g), int(r.lvl), int(r.si), int(r.gp)] + raw + z1 + z2)
    cnt[(pos, g)] = cnt.get((pos, g), 0) + 1
for pos in out['rows']: out['rows'][pos].sort(key=lambda x: x[0])
dst = os.path.join(R, 'hub', 'hub_d1.json')
with open(dst, 'w', encoding='utf-8') as f: json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
print('wrote', dst, os.path.getsize(dst), 'bytes')
for pos in 'FDG': print(pos, len(out['rows'][pos]), {g: cnt.get((pos, g), 0) for g in GROUPS})
