"""Hand-listed personkey fixes for the hub build (hub/hub_player_fixes.json).

  "merge":       [{"from": pk, "to": pk}]                       every row, every season (typos / nicknames the name maps miss)
  "season_team": [{"from": pk, "to": pk, "season": "2025-26", "team": regex}]   only rows of that season whose team name matches
                 (a name a source filed under the wrong person for one team-season, e.g. a younger sister listed under her graduated sister)

Applied by build_hub_json.py (TPE export + portal extras) and build_hub_hudl.py (Hudl export + hand-captured Hudl games), so
hub_pgs, hub_players, hub_toi and hub_hudl all agree. Display names come from master.json for the target personkey.
"""
import json, os, re

def load(out_dir):
    p = os.path.join(out_dir, 'hub_player_fixes.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'merge': [], 'season_team': []}

def apply(df, out_dir, pk='pk', team='team_name', season='gseason', label=''):
    f = load(out_dir); n = 0
    mg = {x['from']: x['to'] for x in f.get('merge', [])}
    if mg:
        new = df[pk].map(lambda k: mg.get(k, k)); n += int((new != df[pk]).sum()); df[pk] = new
    for x in f.get('season_team', []):
        m = (df[pk] == x['from']) & (df[season].astype(str).str.replace('–', '-') == x['season'].replace('–', '-')) & df[team].astype(str).str.contains(x['team'], flags=re.I, regex=True)
        n += int(m.sum()); df.loc[m, pk] = x['to']
    print('personkey fixes (hub_player_fixes.json)%s: %d row(s) re-keyed' % (label, n))
    return df
