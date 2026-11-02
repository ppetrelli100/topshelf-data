import numpy as np, pandas as pd
def metrics(df):
    toi=df.toi_seconds.replace(0,np.nan); gp=df.gp.replace(0,np.nan)
    M=pd.DataFrame(index=df.index)
    p20=lambda c:df[c]/toi*1200
    # usage / volume
    M['TOI per game (min)']=toi/gp/60; M['Shifts per game']=df.shifts/gp; M['Avg shift length (s)']=toi/df.shifts.replace(0,np.nan)
    M['PP TOI share %']=df.pp_toi_seconds/toi*100; M['PK TOI share %']=df.pk_toi_seconds/toi*100
    # box score
    for c,n in [('goals','Goals'),('assists','Assists'),('primary_assists','Primary assists'),('secondary_assists','Secondary assists')]: M[n+' /20']=p20(c)
    M['Points /20']=(df.goals+df.assists)/toi*1200; M['Points per game']=(df.goals+df.assists)/gp
    M['Primary points /20']=(df.goals+df.primary_assists)/toi*1200
    M['Plus-minus /20']=p20('plus_minus')
    # shot generation
    for c,n in [('shots_on_goal','SOG'),('shot_attempts','Shot attempts'),('blocked_shots','Blocked shots (own)'),('scoring_chances','Scoring chances'),('danger_shot_attempts','Danger shot attempts'),('danger_shots_on_goal','SOG danger zone'),('xg','xG'),('xa','xA')]: M[n+' /20']=p20(c)
    M['xG+xA /20']=(df.xg+df.xa)/toi*1200
    M['Shooting % (goals/SOG)']=df.goals/df.shots_on_goal.replace(0,np.nan)*100
    M['SOG per attempt %']=df.shots_on_goal/df.shot_attempts.replace(0,np.nan)*100
    M['Danger share of attempts %']=df.danger_shot_attempts/df.shot_attempts.replace(0,np.nan)*100
    M['xG per shot attempt']=df.xg/df.shot_attempts.replace(0,np.nan)
    M['Goals minus xG /20']=(df.goals-df.xg)/toi*1200
    # possession
    M['Possession time per game (s)']=df.total_possession_seconds/gp
    M['Possession time /20 (s)']=p20('total_possession_seconds')
    M['Possessions /20']=p20('true_total_possessions')
    M['Avg possession length (s)']=df.total_possession_seconds/df.true_total_possessions.replace(0,np.nan)
    M['Giveaways /20']=p20('giveaways'); M['Giveaways % of possessions']=df.giveaways/df.true_total_possessions.replace(0,np.nan)*100
    M['Takeaways /20']=p20('takeaways'); M['Recoveries /20']=p20('recoveries')
    M['Takeaway/giveaway ratio']=df.takeaways/df.giveaways.replace(0,np.nan)
    M['Takeaways minus giveaways /20']=(df.takeaways-df.giveaways)/toi*1200
    for z,n in [('oz','OZ'),('nz','NZ'),('dz','DZ')]:
        M[n+' possession /20 (s)']=p20(z+'_possession_seconds')
        M[n+' possession share %']=df[z+'_possession_seconds']/df.total_possession_seconds.replace(0,np.nan)*100
    # entries
    en=['tpe_entries_successful_controlled','tpe_entries_successful_uncontrolled','tpe_entries_failed_controlled','tpe_entries_failed_uncontrolled']
    ex=[c.replace('entries','exits') for c in en]
    ent=df[en].sum(axis=1).replace(0,np.nan); ext=df[ex].sum(axis=1).replace(0,np.nan)
    M['Entries attempted /20']=ent/toi*1200; M['Controlled entries /20']=p20(en[0]); M['Uncontrolled entries (succ) /20']=p20(en[1])
    M['Carry-in entries /20']=p20('entries_carry_in')
    M['Controlled entry attempt %']=(df[en[0]]+df[en[2]])/ent*100
    M['Entry success %']=(df[en[0]]+df[en[1]])/ent*100
    M['Controlled entry success %']=df[en[0]]/(df[en[0]]+df[en[2]]).replace(0,np.nan)*100
    M['Carry-in share of entries %']=df.entries_carry_in/ent*100
    M['Failed entries /20']=(df[en[2]]+df[en[3]])/toi*1200
    # exits
    M['Exits attempted /20']=ext/toi*1200; M['Controlled exits /20']=p20(ex[0]); M['Carry-out exits /20']=p20('exits_carry_out')
    M['Controlled exit %']=(df[ex[0]]+df[ex[2]])/ext*100
    M['Exit success %']=(df[ex[0]]+df[ex[1]])/ext*100
    M['Controlled exit success %']=df[ex[0]]/(df[ex[0]]+df[ex[2]]).replace(0,np.nan)*100
    M['Carry-out share of exits %']=df.exits_carry_out/ext*100
    M['Failed exits /20']=(df[ex[2]]+df[ex[3]])/toi*1200
    # passing
    pa=(df.passes_successful+df.passes_unsuccessful).replace(0,np.nan); pd_=(df.passes_successful_dz+df.passes_unsuccessful_dz).replace(0,np.nan)
    M['Pass accuracy %']=df.passes_successful/pa*100; M['DZ pass accuracy %']=df.passes_successful_dz/pd_*100
    M['Passes /20']=pa/toi*1200; M['Successful passes /20']=p20('passes_successful'); M['Key passes /20']=p20('key_passes')
    M['Non-DZ pass accuracy %']=(df.passes_successful-df.passes_successful_dz)/(pa-pd_.fillna(0)).replace(0,np.nan)*100
    # on-ice
    for c,n in [('on_ice_goals_for','On-ice GF'),('on_ice_goals_against','On-ice GA'),('on_ice_shots_for','On-ice SF'),('on_ice_shots_against','On-ice SA'),('on_ice_xg_for','On-ice xGF'),('on_ice_xg_against','On-ice xGA')]: M[n+' /20']=p20(c)
    M['On-ice xG share %']=df.on_ice_xg_for/(df.on_ice_xg_for+df.on_ice_xg_against).replace(0,np.nan)*100
    M['On-ice shot share %']=df.on_ice_shots_for/(df.on_ice_shots_for+df.on_ice_shots_against).replace(0,np.nan)*100
    M['On-ice goal share %']=df.on_ice_goals_for/(df.on_ice_goals_for+df.on_ice_goals_against).replace(0,np.nan)*100
    M['On-ice xG diff /20']=(df.on_ice_xg_for-df.on_ice_xg_against)/toi*1200
    M['On-ice shot diff /20']=(df.on_ice_shots_for-df.on_ice_shots_against)/toi*1200
    M['Player share of on-ice xGF %']=df.xg/df.on_ice_xg_for.replace(0,np.nan)*100
    M['Player share of on-ice SF %']=df.shot_attempts/df.on_ice_shots_for.replace(0,np.nan)*100
    M['Player share of on-ice goals %']=(df.goals+df.assists)/df.on_ice_goals_for.replace(0,np.nan)*100
    fo=(df.faceoffs_won+df.faceoffs_lost).replace(0,np.nan)
    M['Faceoff %']=df.faceoffs_won/fo*100; M['Faceoffs /20']=fo/toi*1200
    M.loc[:, :]=M.replace([np.inf,-np.inf],np.nan)
    return M
SEL_F=['SOG danger zone /20','Scoring chances /20','xG /20','Possession time per game (s)','Possessions /20','Giveaways % of possessions','Carry-in entries /20','Controlled entries /20','On-ice SA /20','On-ice xG share %','Pass accuracy %']
SEL_D=['Possession time per game (s)','Possessions /20','Giveaways % of possessions','Carry-out exits /20','Controlled exit %','On-ice SA /20','On-ice xGA /20','Pass accuracy %','DZ pass accuracy %','Controlled entries /20','OZ possession /20 (s)','Scoring chances /20']
BOX=['Points /20','Goals /20','Assists /20','Points per game']
USAGE=['TOI per game (min)','Shifts per game','Avg shift length (s)']

# ---- goalies ----
def goalie_metrics(df):
    toi=df.toi_seconds.replace(0,np.nan); gp=df.gp.replace(0,np.nan); sa=df.shots_against.replace(0,np.nan)
    M=pd.DataFrame(index=df.index)
    M['Save %']=df.saves/sa*100
    M['Goals against /60']=df.goals_against/toi*3600
    M['Shots against /60']=df.shots_against/toi*3600
    M['Saves /60']=df.saves/toi*3600
    M['Shots against per game']=df.shots_against/gp
    M['TOI per game (min)']=toi/gp/60
    return M.replace([np.inf,-np.inf],np.nan)

# ---- catalog for the D1 commits page: (label, category, better 1=higher/-1=lower, ours) ----
C_SHOT='Shot & chance generation'; C_POSS='Puck possession & security'; C_PASS='Passing'; C_ENT='Zone entries'
C_EXIT='Breakouts & exits'; C_ON='On-ice results (team-influenced)'; C_DEF='Defensive actions'; C_BOX='Box score'; C_USE='Usage'; C_OFF='Offensive contribution'
CAT_F=[
 ('xG+xA /20',C_SHOT,1,1),('xG /20',C_SHOT,1,1),('Scoring chances /20',C_SHOT,1,1),('Shot attempts /20',C_SHOT,1,1),('SOG danger zone /20',C_SHOT,1,1),('SOG /20',C_SHOT,1,0),('Shooting % (goals/SOG)',C_SHOT,1,0),
 ('Possession time per game (s)',C_POSS,1,1),('Possessions /20',C_POSS,1,1),('Giveaways % of possessions',C_POSS,-1,1),('Avg possession length (s)',C_POSS,1,0),
 ('Pass accuracy %',C_PASS,1,1),('Successful passes /20',C_PASS,1,1),('Key passes /20',C_PASS,1,0),
 ('Controlled entries /20',C_ENT,1,1),('Carry-in entries /20',C_ENT,1,1),('Entry success %',C_ENT,1,0),('Controlled entry attempt %',C_ENT,1,0),
 ('Controlled exit %',C_EXIT,1,0),('Carry-out exits /20',C_EXIT,1,0),
 ('On-ice SF /20',C_ON,1,1),('On-ice xGF /20',C_ON,1,0),('On-ice xG share %',C_ON,1,1),('On-ice shot share %',C_ON,1,0),('On-ice SA /20',C_ON,-1,0),('On-ice xGA /20',C_ON,-1,0),('Plus-minus /20',C_ON,1,0),
 ('Takeaways /20',C_DEF,1,0),('Recoveries /20',C_DEF,1,0),('Blocked shots (own) /20',C_DEF,1,0),
 ('Points /20',C_BOX,1,0),('Goals /20',C_BOX,1,0),('Assists /20',C_BOX,1,0),('Points per game',C_BOX,1,0),
 ('TOI per game (min)',C_USE,1,0),('PP TOI share %',C_USE,1,0),('PK TOI share %',C_USE,1,0)]
CAT_D=[
 ('Possession time per game (s)',C_POSS,1,1),('Possessions /20',C_POSS,1,1),('Giveaways % of possessions',C_POSS,-1,1),('Avg possession length (s)',C_POSS,1,0),
 ('Pass accuracy %',C_PASS,1,1),('DZ pass accuracy %',C_PASS,1,1),('Successful passes /20',C_PASS,1,0),('Key passes /20',C_PASS,1,0),
 ('Controlled exit %',C_EXIT,1,1),('Recoveries /20',C_EXIT,1,1),('Carry-out exits /20',C_EXIT,1,0),('Controlled exits /20',C_EXIT,1,0),('Exit success %',C_EXIT,1,0),
 ('On-ice shot share %',C_ON,1,1),('On-ice xG share %',C_ON,1,1),('On-ice SA /20',C_ON,-1,1),('On-ice xGA /20',C_ON,-1,1),('On-ice SF /20',C_ON,1,0),('On-ice xGF /20',C_ON,1,0),('Plus-minus /20',C_ON,1,0),
 ('Takeaways /20',C_DEF,1,0),('Blocked shots (own) /20',C_DEF,1,0),('DZ possession /20 (s)',C_DEF,1,0),('PK TOI share %',C_DEF,1,0),
 ('OZ possession /20 (s)',C_OFF,1,1),('Scoring chances /20',C_OFF,1,1),('Controlled entries /20',C_OFF,1,0),('Carry-in entries /20',C_OFF,1,0),('xG+xA /20',C_OFF,1,0),('Shot attempts /20',C_OFF,1,0),
 ('Points /20',C_BOX,1,0),('Goals /20',C_BOX,1,0),('Assists /20',C_BOX,1,0),('Points per game',C_BOX,1,0),
 ('TOI per game (min)',C_USE,1,0),('PP TOI share %',C_USE,1,0)]
CAT_G=[('Save %','Goaltending',1,0),('Goals against /60','Goaltending',-1,0),('Shots against /60','Goaltending',-1,0),('Saves /60','Goaltending',1,0),('Shots against per game','Goaltending',-1,0),('TOI per game (min)','Goaltending',1,0)]
