#!/usr/bin/env python3
"""Turn portal captures (tpe_game_<id>.json) into a hub_extras batch file.
Usage: python3 make_extra_batch.py SPEC.json CAPTURE_DIR OUT_BATCH.json
SPEC (see hub_extras/spec_*.json): batch name, team_ids {portal team name: TPE team id}, alias {portal name: hub name}, defaults, games[].
Each game: tpe_id, date, home, away, home_score, away_score, competition (+ optional result/overtime overrides). The 'home' team is the tracked team
(hub convention for TPE games: tracked_team = home, is_opponent = 1 for the away side)."""
import sys, os, json, uuid, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tpe_capture_to_rows as C
spec = json.load(open(sys.argv[1], encoding='utf-8')); CAP = sys.argv[2]; OUTP = sys.argv[3]
IDS = spec['team_ids']; ALIAS = spec.get('alias', {}); D = dict(dict(result='REGULATION', overtime=False, age_bracket='Unlabeled', event_type='League / season',
      league_family='Prep / high school', country_guess='Unknown', tracked_in_topshelf='N'), **spec.get('defaults', {}))
def season_of(date):  # hub season label, e.g. 2025-12-05 -> '2025–26' (seasons start Aug 1)
    y, m = int(date[:4]), int(date[5:7]); y0 = y if m >= 8 else y - 1
    return '%d–%02d' % (y0, (y0 + 1) % 100)
games = []; bad = 0
for s in spec['games']:
    rows = C.convert(os.path.join(CAP, 'tpe_game_%d.json' % s['tpe_id']))
    htid, atid = IDS[s['home']], IDS[s['away']]
    assert {r['team_id'] for r in rows} == {htid, atid}, (s['tpe_id'], sorted({r['team_id'] for r in rows}), htid, atid)
    hn, an = ALIAS.get(s['home'], s['home']), ALIAS.get(s['away'], s['away'])
    tname = {htid: hn, atid: an}
    gs = collections.Counter()
    for r in rows:
        if r['position'] != 'G': gs[r['team_id']] += r['goals']
    ok = gs[htid] == s['home_score'] and gs[atid] == s['away_score']; bad += (not ok)
    print(s['tpe_id'], s['date'], hn, s['home_score'], '-', s['away_score'], an, 'goals check', 'OK' if ok else 'MISMATCH %s' % dict(gs))
    out = []
    for r in rows:
        if r['toi_seconds'] <= 0: continue
        d = {k: r[k] for k in C.HUBCOLS}
        d.update(player_id='tpe:%d' % r['player_id'], team_id='tpe:%d' % r['team_id'], team_name=tname[r['team_id']],
                 is_opponent=0 if r['team_id'] == htid else 1, position=r['position'], first_name=r['first'], last_name=r['last'])
        out.append(d)
    g = dict(D); g.update({k: s[k] for k in ('result', 'overtime') if k in s})
    games.append(dict(tpe_id=s['tpe_id'], gid=str(uuid.uuid5(uuid.NAMESPACE_URL, 'tpe-game:%d' % s['tpe_id'])), game_date=s['date'], season=season_of(s['date']),
        tracked_team=hn, opponent=an, score_for=s['home_score'], score_against=s['away_score'], result=g['result'], overtime=g['overtime'],
        age_bracket=g['age_bracket'], event_type=g['event_type'], league_family=g['league_family'], country_guess=g['country_guess'],
        competition_label=s['competition'], tracked_in_topshelf=g['tracked_in_topshelf'], rows=out))
json.dump({'batch': spec['batch'], 'source': spec.get('source', ''), 'games': games}, open(OUTP, 'w'), separators=(',', ':'))
print('games', len(games), 'rows', sum(len(g['rows']) for g in games), '| goal mismatches:', bad)
