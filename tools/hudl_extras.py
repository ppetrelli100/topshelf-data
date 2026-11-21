#!/usr/bin/env python3
"""Hand-captured Hudl games (hub_extras/hudl_<date>_<name>.txt + .json) -> player-game rows shaped like the export's
player_game_stats + hudl_player_game_stats join, so build_hub_hudl.py can append them to `pgs`.
A game is skipped when the export already holds it (matched on game.source_record_id = Hudl match id)."""
import os, re, json, glob

SK = ["name", "pos", "toi", "shifts", "g", "a1", "a2", "p", "pm", "pea", "pen", "fo", "fow", "fol", "s", "sog", "sbl", "miss", "ppt", "sht", "pe",
      "cf", "ca", "ff", "fa", "xg", "xgon", "xgopp", "fod", "fodw", "fon", "fonw", "foa", "foaw", "wgt", "hgt"]
GK = ["name", "toi", "ga", "sa", "sv", "xgc"]

def secs(v):
    m = re.match(r'^(\d+):(\d{2})$', v or '')
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 0
def num(v):
    if v in (None, '', '-'): return 0
    try: return float(v.replace('%', ''))
    except ValueError: return 0

def load(extras_dir, have_ids):
    """-> (rows, games). rows: list of dicts; games: {hudl id: meta}. have_ids: Hudl match ids the export already has."""
    rows, games = [], {}
    for txt in sorted(glob.glob(os.path.join(extras_dir, 'hudl_*.txt'))):
        meta = json.load(open(txt[:-4] + '.json', encoding='utf-8'))['games']
        cur = None; team = None; teams = {}; kind = None
        def flush_game(gid): pass
        for line in open(txt, encoding='utf-8').read().split('\n'):
            if not line: continue
            if line[0] == '#': cur = line[1:]; teams = {}; kind = None; continue
            if line[:2] in ('T0', 'T1') and '|' in line and line[2] == '|':
                idx = int(line[1]); teams[idx] = line.split('|', 1)[1]; team = teams[idx]; kind = 'S'; continue
            if line in ('G0', 'G1'):
                team = teams[int(line[1])]; kind = 'G'; continue
            if cur in have_ids or cur not in meta: continue
            f = line.split('|'); m = meta[cur]
            if kind == 'S':
                f += [''] * (len(SK) - len(f)); d = dict(zip(SK, f))
                rows.append(dict(hid=cur, team=team, name=d['name'].split('~', 1)[-1], jersey=d['name'].split('~', 1)[0], pos=d['pos'], goalie=0,
                    toi_seconds=secs(d['toi']), shifts=num(d['shifts']), shots_on_goal=num(d['sog']), shot_attempts=num(d['s']), shots_missed_net=num(d['miss']),
                    blocked_shots=num(d['sbl']), plus_minus=num(d['pm']), pp_toi_seconds=secs(d['ppt']), pk_toi_seconds=secs(d['sht']),
                    faceoffs_won=num(d['fow']), faceoffs_lost=num(d['fol']), goals_hudl=num(d['g']), points_hudl=num(d['p']), penalties=num(d['pe']),
                    pim_seconds=secs(d['pen']), corsi_for=num(d['cf']), corsi_against=num(d['ca']), fenwick_for=num(d['ff']), fenwick_against=num(d['fa']),
                    xg_hudl=num(d['xg']), xg_on_ice_for=num(d['xgon']), xg_on_ice_against=num(d['xgopp']), date=m['date']))
            elif kind == 'G':
                f += [''] * (len(GK) - len(f)); d = dict(zip(GK, f))
                rows.append(dict(hid=cur, team=team, name=d['name'].split('~', 1)[-1], jersey=d['name'].split('~', 1)[0], pos='G', goalie=1,
                    toi_seconds=secs(d['toi']), shifts=0, shots_on_goal=num(d['sa']), shot_attempts=0, shots_missed_net=0, blocked_shots=0, plus_minus=0,
                    pp_toi_seconds=0, pk_toi_seconds=0, faceoffs_won=0, faceoffs_lost=0, goals_hudl=0, points_hudl=0, penalties=0, pim_seconds=0,
                    corsi_for=0, corsi_against=0, fenwick_for=0, fenwick_against=0, xg_hudl=0, xg_on_ice_for=0, xg_on_ice_against=num(d['xgc']), date=m['date']))
        for k, v in meta.items():
            if k not in have_ids: games[k] = v
    return rows, games

if __name__ == '__main__':
    import sys
    r, g = load(sys.argv[1] if len(sys.argv) > 1 else 'hub_extras', set())
    print(len(r), 'rows,', len(g), 'games')
