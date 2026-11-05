"""Convert one captured TPE portal game (feeds from the page's own XHR responses) into hub-shaped player-game rows.
Source: /api/stat/players/metrics/total (Configurator, all metrics), /api/games/possession/players,
/api/games/score/players (goalie saves/SA/GA, pp/pk toi), extract-players (position), profiles/extract (names)."""
import json, collections
HUBCOLS = ['toi_seconds','shifts','goals','assists','primary_assists','secondary_assists','shots_on_goal','shot_attempts','blocked_shots',
 'scoring_chances','danger_shot_attempts','plus_minus','passes_successful','passes_unsuccessful','key_passes','total_possession_seconds',
 'oz_possession_seconds','nz_possession_seconds','dz_possession_seconds','true_total_possessions','recoveries','giveaways',
 'tpe_entries_successful_controlled','tpe_entries_successful_uncontrolled','tpe_entries_failed_controlled','tpe_entries_failed_uncontrolled',
 'tpe_exits_successful_controlled','tpe_exits_successful_uncontrolled','tpe_exits_failed_controlled','tpe_exits_failed_uncontrolled',
 'on_ice_goals_for','on_ice_goals_against','danger_shots_on_goal','entries_carry_in','exits_carry_out','on_ice_shots_for','on_ice_shots_against',
 'passes_successful_dz','passes_unsuccessful_dz','on_ice_xg_for','on_ice_xg_against','takeaways','xg','xa','faceoffs_won','faceoffs_lost',
 'pp_toi_seconds','pk_toi_seconds','saves','shots_against','goals_against','avg_possession_seconds']
# goalies: the hub zeroes these skater-only columns
G_ZERO = ['goals','shots_on_goal','scoring_chances','plus_minus','on_ice_goals_for','on_ice_goals_against','on_ice_shots_for','on_ice_shots_against','on_ice_xg_for','on_ice_xg_against']
M = {
'toi_seconds':lambda m:m['toi']//10,'shifts':lambda m:m['shifts'],'goals':lambda m:m['goals'],
'assists':lambda m:m['primary_assists']+m['secondary_assists'],'primary_assists':lambda m:m['primary_assists'],'secondary_assists':lambda m:m['secondary_assists'],
'shots_on_goal':lambda m:m['shots_on_goal'],'shot_attempts':lambda m:m['shot_attempts'],'blocked_shots':lambda m:m['blocked_shots_by'],'scoring_chances':lambda m:m['scoring_chances'],
'danger_shot_attempts':lambda m:m['shot_attempts_from_danger_zone'],'plus_minus':lambda m:m['plus_minus'],
'passes_successful':lambda m:m['successful_passes_in_oz']+m['successful_passes_in_nz']+m['successful_passes_in_dz'],
'passes_unsuccessful':lambda m:m['unsuccessful_passes_in_oz']+m['unsuccessful_passes_in_nz']+m['unsuccessful_passes_in_dz'],
'key_passes':lambda m:m['key_passes'],'total_possession_seconds':lambda m:m['possession_time']//10,'oz_possession_seconds':lambda m:m['possession_time_oz']//10,
'nz_possession_seconds':lambda m:m['possession_time_nz']//10,'dz_possession_seconds':lambda m:m['possession_time_dz']//10,
'recoveries':lambda m:m['recoveries'],'giveaways':lambda m:m['giveaways'],
'tpe_entries_successful_controlled':lambda m:m['controlled_successful_entries'],'tpe_entries_successful_uncontrolled':lambda m:m['uncontrolled_successful_entries'],
'tpe_entries_failed_controlled':lambda m:m['controlled_failed_entries'],'tpe_entries_failed_uncontrolled':lambda m:m['uncontrolled_failed_entries'],
'tpe_exits_successful_controlled':lambda m:m['controlled_successful_exits'],'tpe_exits_successful_uncontrolled':lambda m:m['uncontrolled_successful_exits'],
'tpe_exits_failed_controlled':lambda m:m['controlled_failed_exits'],'tpe_exits_failed_uncontrolled':lambda m:m['uncontrolled_failed_exits'],
'on_ice_goals_for':lambda m:m['on_ice_goals_for'],'on_ice_goals_against':lambda m:m['on_ice_goals_against'],'danger_shots_on_goal':lambda m:m['shots_on_goal_danger_zone'],
'entries_carry_in':lambda m:m['carry_in_entries'],'exits_carry_out':lambda m:m['carry_out_count'],
'on_ice_shots_for':lambda m:m['on_ice_shots_for'],'on_ice_shots_against':lambda m:m['on_ice_shots_against'],
'passes_successful_dz':lambda m:m['successful_passes_in_dz'],'passes_unsuccessful_dz':lambda m:m['unsuccessful_passes_in_dz'],
'on_ice_xg_for':lambda m:round(m['on_ice_xg_for']/100,2),'on_ice_xg_against':lambda m:round(m['on_ice_xg_against']/100,2),
'takeaways':lambda m:m['interceptions'],'xg':lambda m:round(m['xg']/100,2),'xa':lambda m:round(m['xa']/100,2),
'faceoffs_won':lambda m:m['face_off_won'],'faceoffs_lost':lambda m:m['face_off_lost'],
}
def _feed(F, frag, pick=None):
    ks=[k for k in F if frag in k]
    if not ks: return None
    best=None
    for k in ks:
        for e in F[k]:
            try: j=json.loads(e['t'])
            except Exception: continue
            if pick and not pick(e): continue
            if best is None or len(j)>len(best): best=j
    return best
def _feed_all(F, frag, flt=None):
    out=[]
    for k in F:
        if frag in k:
            for e in F[k]:
                try: j=json.loads(e['t'])
                except Exception: continue
                out.extend(x for x in j if (flt is None or flt(x)))
    return out
def convert(path):
    d=json.load(open(path)); F=d['feeds']
    mk=max([k for k in F if 'metrics/total?metric=on_ice' in k], key=len)
    mj=json.loads([e for e in F[mk] if 'strengths' not in e['b']][0]['t'])
    poss={r['playerId']:r for r in (_feed(F,'possession/players') or [])}
    ex=_feed_all(F,'extract-players-by-game-ids',lambda e:(str(e.get('gameId'))==str(d['gid'])) if 'gid' in d else True)
    g2p={e['id']:e['playerId'] for e in ex}; pos={e['playerId']:e.get('playerPosition') for e in ex}
    score={}
    for s in (_feed(F,'score/players') or []):
        if s['gamePlayerId'] in g2p: score[g2p[s['gamePlayerId']]]=s
    prof={p['id']:p for p in _feed_all(F,'players/profiles/extract')}
    rows=[]
    for t in mj:
        for p in t['players']:
            pid=p['playerId']; m=p['metrics']
            r={c:f(m) for c,f in M.items()}
            ps=poss.get(pid)
            r['true_total_possessions']=ps['possessionCount'] if ps else 0
            r['avg_possession_seconds']=(round(ps['possessionTime']/10/ps['possessionCount'],1) if ps and ps['possessionCount'] else 0)
            s=score.get(pid); a=s['all'] if s else {}
            r['pp_toi_seconds']=(s['pp']['toi']//10) if s else 0; r['pk_toi_seconds']=(s['pk']['toi']//10) if s else 0
            g = pos.get(pid)=='G'
            r['saves']=a.get('saves',0) if g else 0; r['shots_against']=a.get('shotsOnGoalAgainst',0) if g else 0; r['goals_against']=a.get('goalsAgainst',0) if g else 0
            if g:
                for c in G_ZERO: r[c]=0
            pr=prof.get(pid,{})
            fn=pr.get('firstNameEn') or pr.get('firstname') or ''; ln=pr.get('lastNameEn') or pr.get('lastname') or ''
            rows.append(dict(player_id=pid, team_id=t['teamId'], position=pos.get(pid), first=fn, last=ln, **r))
    return rows
