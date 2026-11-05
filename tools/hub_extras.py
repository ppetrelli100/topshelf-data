#!/usr/bin/env python3
"""Manage the hub 'extras': TPE games captured from the portal and appended to the hub on top of the friend's Hub export.

  python3 hub_extras.py status  [EXPORT_DIR]   which extras are still active, which the export now has
  python3 hub_extras.py compare [EXPORT_DIR]   for games the export now has: check the portal capture against the export (per-team totals)
  python3 hub_extras.py prune   [EXPORT_DIR]   move games the export now has out of hub_extras/batch_*.json into hub_extras/absorbed/ (then rebuild the hub)

Matching is on the TPE game id (extras 'tpe_id' == export game.csv 'source_record_id'). Run from anywhere; paths default to ~/mnt/...
"""
import sys, os, json, glob, shutil, datetime
import pandas as pd
HOME = os.path.expanduser('~')
TSD = os.environ.get('TSD') or os.path.join(HOME, 'mnt/topshelf-data')
XD = os.path.join(TSD, 'hub_extras')
cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
EXP = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HOME, 'mnt/Hub Export 2026-10-31')

def load_batches(folder):
    out = []
    for f in sorted(glob.glob(os.path.join(folder, 'batch_*.json'))):
        out.append((f, json.load(open(f, encoding='utf-8'))))
    return out

game = pd.read_csv(os.path.join(EXP, 'game.csv'), usecols=['id', 'source_system', 'source_record_id', 'superseded_by_game_id'], low_memory=False)
game = game[(game.source_system == 'tpe') & game.superseded_by_game_id.isna()]
EXPORT_ID = dict(zip(game.source_record_id.astype(str), game.id))
batches = load_batches(XD)

if cmd == 'status':
    n_act = n_abs = 0
    for f, b in batches:
        print('\n%s  (%s)' % (os.path.basename(f), b.get('batch')))
        for g in b['games']:
            ab = str(g['tpe_id']) in EXPORT_ID
            n_abs += ab; n_act += (not ab)
            print('  %s %-7s %s  %s v %s  %s' % ('ABSORBED' if ab else 'active  ', g['tpe_id'], g['game_date'], g['tracked_team'], g['opponent'], g['competition_label']))
    arch = sum(len(json.load(open(f))['games']) for f in glob.glob(os.path.join(XD, 'absorbed', 'batch_*.json')))
    print('\nactive %d | in the export now (run prune) %d | already archived %d' % (n_act, n_abs, arch))

elif cmd in ('compare', 'prune'):
    absorbed = [(f, g) for f, b in batches for g in b['games'] if str(g['tpe_id']) in EXPORT_ID]
    if cmd == 'compare':
        # also compare games archived earlier
        for f, b in load_batches(os.path.join(XD, 'absorbed')):
            absorbed += [(f, g) for g in b['games'] if str(g['tpe_id']) in EXPORT_ID]
        if not absorbed:
            print('no extra game is in the export yet - nothing to compare'); sys.exit(0)
        gids = {EXPORT_ID[str(g['tpe_id'])] for _, g in absorbed}
        COLS = ['toi_seconds', 'shifts', 'goals', 'assists', 'shots_on_goal', 'shot_attempts', 'blocked_shots', 'plus_minus', 'giveaways', 'recoveries', 'on_ice_goals_for', 'on_ice_shots_for']
        pgs = pd.read_csv(os.path.join(EXP, 'player_game_stats.csv'), usecols=['game_id', 'team_id', 'toi_seconds'] + [c for c in COLS if c != 'toi_seconds'], low_memory=False)
        pgs = pgs[pgs.game_id.isin(gids) & (pgs.toi_seconds.fillna(0) > 0)]
        bad = 0
        for _, g in absorbed:
            e = pgs[pgs.game_id == EXPORT_ID[str(g['tpe_id'])]]
            ex = sorted(tuple(int(round(v)) for v in grp[COLS].fillna(0).sum()) + (len(grp),) for _, grp in e.groupby('team_id'))
            mine = {}
            for r in g['rows']: mine.setdefault(r['team_id'], []).append(r)
            mi = sorted(tuple(int(round(sum(x[c] for x in rs))) for c in COLS) + (len(rs),) for rs in mine.values())
            ok = ex == mi
            bad += (not ok)
            print('%s %s %s v %s: %s' % (g['tpe_id'], g['game_date'], g['tracked_team'], g['opponent'], 'MATCH (per-team totals of %d columns + player count)' % len(COLS) if ok else 'DIFFERENT'))
            if not ok: print('   export :', ex); print('   capture:', mi)
        print('\n%d game(s) compared, %d different' % (len(absorbed), bad))
    else:
        if not absorbed:
            print('nothing to prune'); sys.exit(0)
        os.makedirs(os.path.join(XD, 'absorbed'), exist_ok=True)
        today = datetime.date.today().isoformat()
        for f, b in batches:
            gone = [g for g in b['games'] if str(g['tpe_id']) in EXPORT_ID]
            if not gone: continue
            keep = [g for g in b['games'] if str(g['tpe_id']) not in EXPORT_ID]
            af = os.path.join(XD, 'absorbed', os.path.basename(f))
            prev = json.load(open(af))['games'] if os.path.exists(af) else []
            json.dump(dict(b, games=prev + gone, absorbed_on=today), open(af, 'w'), separators=(',', ':'))
            if keep: json.dump(dict(b, games=keep), open(f, 'w'), separators=(',', ':'))
            else: os.remove(f)
            print('%s: archived %d game(s) to absorbed/, %d left' % (os.path.basename(f), len(gone), len(keep)))
        print('now rebuild the hub: python3 tools/build_hub_json.py')
else:
    print(__doc__)
