"""d1_model.py -- US D1 probability model (first version, Nov 2026). Writes ../../hockeyfile/d1prob.json (site folder, owner-only; never the public repo) for the playerview "D1 outlook" tab.
Training: US players born 2006/2007 in the recruited pool (see d1_rates.py). One ridge-logistic model per as-of age 15/16/17 using
 best camp to date, U1617 repeat, position, club D1 rate (leave-one-out, shrunk with prior weight CLUB_A=20, plus a club x has-camp term),
 Hub TPE composite vs level (key metrics), and camp performance: the tpe.html composite (default weights, z within camp x position) as a percentile in the camp pool
 (top-quartile flag at U16-17; the U15 term is untrained until 2008+ cohorts resolve).
Tier: multinomial over D1 players only (weak signal). Run: python3 d1_model.py [--cv]  (--cv prints leave-one-cohort-out AUC/Brier/calibration)
"""
import json,os,re,sys,math,collections as C
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score,brier_score_loss
D=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')+'/'
SYN=[('mn ','minnesota '),('ct ','connecticut '),('naha','north american academy'),('nh ','new hampshire '),('nj ','new jersey '),('honeybaked','detroit honeybaked'),('little caesars','detroit little caesars'),('belle tire','detroit belle tire'),('spitfires','massachusetts spitfires'),('islanders','middlesex islanders'),('cpc boston americans','boston americans'),('bk selects','bishop kearney selects'),('midfairfield','mid fairfield'),('jr whitecaps','whitecaps'),('tiger lillies','tiger lilies'),('lovell academy','lovell academy lions'),('culver academies','culver academies eagles'),('shattuck st mary s','shattuck st mary s')]
COLORS='silver|blue|white|gold|sky|green|black|navy|red|orange|vegas|purple'
def norm(s):
    # team colors are real distinct teams in MHR (Minnesota Elite (Silver) vs (Blue) ...): keep them, whether written in parentheses or not
    cols=' '.join(re.findall(r'\((%s)\)'%COLORS,s,flags=re.I))
    s=re.sub(r'\([^)]*\)','',s).lower()+' '+cols.lower()
    s=re.sub(r'\b(14u|16u|19u|u15|u18|u22|prep|jr\.?|junior|lady|girls|women|womens|hockey|club|the|major|royal|elite2|\d+ ?2)\b','',s)
    s=re.sub(r'[^a-z0-9]+',' ',s).strip()
    s=' '+s+' '
    for a,b in SYN: s=s.replace(' '+a.strip()+' ',' '+b+' ') if not a.endswith(' ') else s.replace(' '+a,' '+b)
    return re.sub(r'\s+',' ',s).strip()
def match(n,names):
    if n in names: return names[n]
    for m,v in names.items():
        if m.startswith(n) or n.startswith(m): return v
    return None
h=json.load(open(D+'mhr_history.json')); cur=json.load(open(D+'mhr_current.json'))
rank={}
for lvl,season,rk,team,*_ in h['rows']: rank.setdefault((season,lvl),{}).setdefault(norm(team),(rk,team))
for row in cur['rows']: rank.setdefault(('2026-27',row[0]),{}).setdefault(norm(row[2]),(row[1],row[2]))
r=json.load(open(D+'rosters.json')); c=json.load(open(D+'commits.json')); cs={x['personkey'] for x in c}
lv={'16U':'USA 16U','19U':'USA 19U'}

m=json.load(open(D+'master.json')); d1=json.load(open(D+'d1.json')); M={x['PersonKey']:x for x in m}
# ---- population (same as d1_rates.py)
pop={}
for s,teams in r.items():
    for t in teams:
        if t['country']!='US' or t['lvl'] not in lv: continue
        hit=match(norm(t['team']),rank.get((s,lv[t['lvl']]),{}))
        k=sum(p['pk'] in cs for p in t['players']); top=bool(hit and hit[0]<=25)
        if top or k:
            for p in t['players']: pop.setdefault(p['pk'],set()).add('x')
for x in json.load(open(D+'ndc.json')):
    if x.get('Country')=='US' or x.get('STATE'): pop.setdefault(x['personkey'],set()).add('camp')
# club per player (most frequent US 16U/19U roster club)
# club / team = the player's MOST RECENT US 16U/19U roster entry. Newer seasons win; when a player is rostered on several teams in that
# season (e.g. MN Elite Silver 16U and MN Whitecaps Black 19U) the BEST MHR-ranked team wins (unranked teams lose ties).
SW={'2024-25':1,'2025-26':10,'2026-27':100}
best_entry={}   # pk -> (season weight, -rank, club, rank)
for s,teams in r.items():
    for t in teams:
        if t['country']!='US' or t['lvl'] not in lv: continue
        hit=match(norm(t['team']),rank.get((s,lv[t['lvl']]),{})); rk=hit[0] if hit else None
        key=(SW[s],-(rk if rk is not None else 999))
        for p in t['players']:
            cur=best_entry.get(p['pk'])
            if cur is None or key>cur[0]: best_entry[p['pk']]=(key,t['club'],rk)
clubof=C.defaultdict(C.Counter); teamrank={}
for pk,(key,club,rk) in best_entry.items(): clubof[pk][club]=1; teamrank[pk]=(key[0],rk)
# ---- USAH TPE simplified composite (direct columns, z within camp x position)
S=open(os.path.join(D,'..','hockeyfile','tpe_static.js')).read()
T,_=json.JSONDecoder().raw_decode(S[S.index('const TPE_STATIC =')+18:].lstrip()); H=T['header']; R=T['rows']; ix={h:i for i,h in enumerate(H)}
# faithful re-implementation of tpe.html's composite (default weights; z within camp x position; percentile within the camp pool)
def f(row,c):
    v=row[ix[c]] if c in ix else None
    try: return float(v)
    except: return None
def per20(row,c,scale=1):
    v=f(row,c); toi=f(row,'TOI_min')
    return None if v is None or not toi or toi<=0 else v*scale/toi*20
def mval(row,key):
    if key=='possTime':
        a,b=f(row,'Number of possessions'),f(row,'Time per possession'); return None if a is None or b is None else a*b
    if key=='numPoss': return per20(row,'Number of possessions')
    if key=='carryOut': return per20(row,'Carry out exits')
    if key=='carryIn': return per20(row,'Carry in entries')
    if key=='ozPoss': return per20(row,'Possession time  OZ',1440)
    if key=='oiShotsAg': return per20(row,'On ice shots against')
    return f(row,{'givePct':'Giveaways  %','ctrlOutPct':'Controlled exits  %','dzShots':'SOG_DangerZone_per20','scChances':'ScoringChances_per20','xg':'xG_per20','ctrlIn':'CtrlEntries_per20','oiXgAg':'OnIce_xGAgainst_per20','oiXgShare':'OnIce_xGRatio','passAcc':'Passing accuracy  %','passAccDZ':'Passing accuracy DZ  %'}[key])
LOWER={'givePct','oiShotsAg','oiXgAg'}
CATS={'F':[('Shot',30,['dzShots','scChances','xg']),('Poss',20,['possTime','numPoss','givePct']),('Entries',15,['carryIn','ctrlIn']),('Def',30,['oiShotsAg','oiXgShare']),('Pass',5,['passAcc'])],
      'D':[('Poss',40,['possTime','numPoss','givePct','carryOut','ctrlOutPct']),('Supp',25,['oiShotsAg','oiXgAg']),('Off',30,['ctrlIn','ozPoss','scChances']),('Pass',5,['passAcc','passAccDZ'])]}
pl=C.defaultdict(list)
for row in R:
    pk=row[ix['ResolvedPersonKey']]; pos=(M.get(pk) or {}).get('Position') or row[ix['Position']]
    if pos in CATS: pl[(row[ix['ImportLabel']],pos)].append((pk,row))
usah2=C.defaultdict(list)   # pk -> [(year, level, pctl)]
for (lab,pos),lst in pl.items():
    yr=int(re.search(r'20\d\d',lab).group()); lv_=re.search(r'NDC (\S+)',lab).group(1)
    keys=[k for _,_,ks in CATS[pos] for k in ks]; Z={}
    for k in keys:
        vs=[mval(rw,k) for _,rw in lst]; vv=[v for v in vs if v is not None]
        if len(vv)<3 or np.std(vv)==0: continue
        mu,sd=np.mean(vv),np.std(vv)
        Z[k]=[(None if v is None else (-1 if k in LOWER else 1)*(v-mu)/sd) for v in vs]
    comp=[]
    for i in range(len(lst)):
        num=den=0
        for _,w,ks in CATS[pos]:
            zs=[Z[k][i] for k in ks if k in Z and Z[k][i] is not None]
            if zs: num+=w*np.mean(zs); den+=w
        comp.append(num/den if den else None)
    ok=sorted(c for c in comp if c is not None)
    for (pk,_),c in zip(lst,comp):
        if c is None: continue
        below=sum(1 for v in ok if v<c); usah2[pk].append((yr,lv_,below/(len(ok)-1) if len(ok)>1 else .5,c))

# ---- Hub TPE composite vs same level/season (lens 1), key metrics only
h=json.load(open(D+'hub/hub_d1.json')); hubz={}
for pos in 'FD':
    mets=h['metrics'][pos]; K=len(mets); off=7+1*K
    for row in h['rows'][pos]:
        if row[6]<5: continue
        zs=[mets[k]['dir']*row[off+k] for k in range(K) if mets[k]['ours'] and row[off+k] is not None]
        if zs: hubz[row[1]]=(float(np.mean(zs)),row[4],row[6])   # z, level idx, gp
def slots(p,by):
    # camp slot i is the summer of (Grad-4+i); age = that year - birth year (Grad is not always BirthYr+19)
    g=p.get('Grad') if isinstance(p.get('Grad'),int) else by+19
    return [(g-4+i-by,p.get(k)) for i,k in enumerate(['Fresh','Soph','Jr','Sr'])]
def labs_to(x,age): return [l for (a,l) in x['labs'] if a<=age]
RANK={'U15':1,'U1617':2,'U18':3,'WNT':4,'WNT-C':4}
def best(l): return max([RANK.get(x,0) for x in l]+[0])
rows=[]
for pk in pop:
    p=M.get(pk)
    if not p or p.get('Country')!='US' or p.get('BirthYr') not in (2006,2007,2008): continue
    if p['BirthYr']==2008 and (p.get('Grad') if isinstance(p.get('Grad'),int) else 2026)>2026: continue   # 2008s: only the class of 2026 is fully resolved
    col=p.get('College'); out='D1' if col in d1 else ('other' if col else 'none')
    rows.append(dict(pk=pk,by=p['BirthYr'],pos=p.get('Position'),y=int(out=='D1'),tier=int(d1[col]['tier']) if col in d1 else None,
        labs=slots(p,p['BirthYr']),club=(clubof[pk].most_common(1)[0][0] if clubof.get(pk) else None)))
COH=sorted(set(x['by'] for x in rows)); print('cohorts',{b:sum(1 for x in rows if x['by']==b) for b in COH})
print('rows',len(rows),'with club',sum(1 for x in rows if x['club']),'hub',sum(1 for x in rows if x['pk'] in hubz),'usah',sum(1 for x in rows if x['pk'] in usah2))
CLUB_A=20.0; INTERACT=True
def clubrate(train,club,exclude_pk=None,a=None):
    a=CLUB_A if a is None else a
    g=sum(x['y'] for x in train)/len(train); n=k=0
    for x in train:
        if x['club']==club and x['pk']!=exclude_pk: n+=1; k+=x['y']
    return (k+a*g)/(n+a), n
def feats(x,age,train,loo,sets):
    k=age-14; labs=labs_to(x,age)   # age15->1,16->2,17->3
    b=best(labs); n16=sum(1 for l in labs if l=='U1617')
    f=[b==1,b==2,b>=3,n16>=1,x['pos']=='D']
    if 'club' in sets:
        cr,n=clubrate(train,x['club'],x['pk'] if loo else None) if x['club'] else (sum(t['y'] for t in train)/len(train),0)
        f+= [math.log(cr/(1-cr))]
    if 'hub' in sets:
        hz=hubz.get(x['pk']); ok=hz and (hz[1]<=1 if age<=17 else True)
        f+= [hz[0] if ok else 0.0, 0.0 if ok else 1.0]
    if 'usah' in sets:
        yr_by=x['by']; us=[z for (yr,z) in usah.get(x['pk'],[]) if yr-yr_by<=age]
        f+= [float(np.mean(us)) if us else 0.0, 0.0 if us else 1.0]
    return f
def run(age,sets,target='d1'):
    res=[]
    for te_by in COH:
        tr=[x for x in rows if x['by']!=te_by]; te=[x for x in rows if x['by']==te_by]
        if target=='tier': tr=[x for x in tr if x['tier']]; te=[x for x in te if x['tier']]
        yv=(lambda x:x['y']) if target=='d1' else (lambda x:int(x['tier']<=2))
        base=[x for x in rows if x['by']!=te_by]   # club rates from the training cohorts only
        Xtr=np.array([design(x,age,sets,base,True)[0] for x in tr],float); Xte=np.array([design(x,age,sets,base,False)[0] for x in te],float)
        mu=Xtr.mean(0); sd=Xtr.std(0)+1e-9
        clf=LogisticRegression(C=0.5,max_iter=500).fit(np.clip((Xtr-mu)/sd,-2.5,2.5),[yv(x) for x in tr])
        p=clf.predict_proba(np.clip((Xte-mu)/sd,-2.5,2.5))[:,1]; res+=list(zip(p,[yv(x) for x in te]))
    p=np.array([a for a,_ in res]); y=np.array([b for _,b in res])
    return roc_auc_score(y,p),brier_score_loss(y,p),p,y

# ================= final fit + scoring =================
import datetime
LAB={'camp15':'Best camp (age 15)','camp':'Camp level','n16':'Repeat U1617','pos':'Position','club':'Club track record','hub':'TPE game data vs peers','usah':'USAH camp TPE'}
def design(x,age,sets,train,loo):
    labs=labs_to(x,age); b=best(labs); n16=sum(1 for l in labs if l=='U1617'); names=[]; f=[]
    f+=[b==1,b==2,b>=3,n16>=1,x['pos']=='D']; names+=['camp:U15','camp:U1617','camp:U18/WNT','n16','pos:D']
    cr=None
    if 'club' in sets:
        g=sum(t['y'] for t in train)/len(train)
        cr,n=clubrate(train,x['club'],x['pk'] if loo else None) if x['club'] else (g,0)
        lc=math.log(cr/(1-cr)); f.append(lc); names.append('club')
        if INTERACT: f.append(lc*float(b>0)); names.append('club*camp')
    if 'mhr' in sets:
        rk=teamrank.get(x['pk'],(0,None))[1]
        f+=[float(rk is not None and rk<=10), float(rk is not None and 10<rk<=25)]; names+=['mhr10','mhr25']
    if 'hub' in sets:
        hz=hubz.get(x['pk']); ok=hz and (hz[1]<=1 if age<=17 else True)
        f+=[hz[0] if ok else 0.0, 0.0 if ok else 1.0]; names+=['hub','hub?']
    if 'usah' in sets:
        cm=[(l,pc) for (yr,l,pc,z) in usah2.get(x['pk'],[]) if yr-x['by']<=age]
        p17=[pc for l,pc in cm if l=='U16-17']; p15=[pc for l,pc in cm if l=='U15']
        pc17=max(p17) if p17 else None; pc15=max(p15) if p15 else None
        f+=[(pc17-0.5) if p17 else 0.0, float(bool(p17) and pc17>=0.75), (pc15-0.5) if p15 else 0.0, 0.0 if cm else 1.0]; names+=['pc1617','q4','pc15','usah?']
    return f,names,cr
SETS=['club','mhr','hub','usah']
def fit(age):
    Xl=[];ys=[]
    for x in rows:
        f,names,_=design(x,age,SETS,rows,True); Xl.append(f); ys.append(x['y'])
    X=np.array(Xl,float); mu=X.mean(0); sd=X.std(0)+1e-9
    clf=LogisticRegression(C=0.5,max_iter=500).fit(np.clip((X-mu)/sd,-2.5,2.5),ys)
    return dict(clf=clf,mu=mu,sd=sd,names=names)
def why(mod,f,x,cr):
    z=np.clip((np.array(f,float)-mod['mu'])/mod['sd'],-2.5,2.5); c=z*mod['clf'].coef_[0]; out=[]
    nm=mod['names']
    def add(label,val):
        if abs(val)>=0.12: out.append([label,round(float(val),2)])
    cm=sum(c[i] for i,n in enumerate(nm) if n.startswith('camp') or n=='n16')
    camp_best=nm
    add('Camp history',cm)
    add('Position',c[nm.index('pos:D')])
    if 'club' in nm: add('Club track record'+(' ('+x['club']+')' if x['club'] else ' (unknown club)'),c[nm.index('club')]+(c[nm.index('club*camp')] if 'club*camp' in nm else 0))
    if 'hub' in nm: add('TPE game data',c[nm.index('hub')]+c[nm.index('hub?')])
    if 'mhr10' in nm: add('Team strength (MHR rank)',c[nm.index('mhr10')]+c[nm.index('mhr25')])
    if 'q4' in nm: add('Camp performance (TPE)',c[nm.index('pc1617')]+c[nm.index('q4')]+c[nm.index('pc15')]+c[nm.index('usah?')])
    out.sort(key=lambda a:-abs(a[1])); return out[:4]
def tier_model():
    d=[x for x in rows if x['tier']]; Xl=[design(x,17,['club','usah'],rows,True)[0] for x in d]
    X=np.array(Xl,float); mu=X.mean(0); sd=X.std(0)+1e-9
    clf=LogisticRegression(C=0.1,max_iter=1000).fit(np.clip((X-mu)/sd,-2.5,2.5),[x['tier'] for x in d]); return clf,mu,sd
if __name__=='__main__' and '--cv' in sys.argv:
    for target in ('d1','tier'):
        print('=== target',target)
        for age in (15,16,17):
            line=[]
            for name,sets in (('camp',[]),('+club',['club']),('+mhr',['club','mhr']),('+perf',['club','usah']),('all',['club','mhr','hub','usah'])):
                a,b,_,_=run(age,sets,target); line.append('%s AUC %.3f Brier %.3f'%(name,a,b))
            print('age',age,' | '.join(line))
    for age in (15,16,17):
        a,b,p,y=run(age,['club','mhr','hub','usah'])
        print('calibration age',age,'(pred bin: n, pred, actual)')
        for lo,hi in ((0,.2),(.2,.4),(.4,.6),(.6,.8),(.8,1.01)):
            sel=(p>=lo)&(p<hi); print('   %.1f-%.1f n=%3d pred=%.2f actual=%.2f'%(lo,hi,sel.sum(),p[sel].mean() if sel.any() else 0,y[sel].mean() if sel.any() else 0))
if __name__=='__main__' and '--cv' not in sys.argv:
    from sklearn.isotonic import IsotonicRegression
    mods={a:fit(a) for a in (15,16,17)}; tclf,tmu,tsd=tier_model()
    # ---- out-of-fold scores (leave-one-cohort-out) at each age, used for calibration, the error band and the back-test table
    def oof(age):
        res={}
        for te_by in COH:
            tr=[x for x in rows if x['by']!=te_by]; te=[x for x in rows if x['by']==te_by]
            Xtr=np.array([design(x,age,SETS,tr,True)[0] for x in tr],float); Xte=np.array([design(x,age,SETS,tr,False)[0] for x in te],float)
            mu=Xtr.mean(0); sd=Xtr.std(0)+1e-9
            clf=LogisticRegression(C=0.5,max_iter=500).fit(np.clip((Xtr-mu)/sd,-2.5,2.5),[x['y'] for x in tr])
            for x,p in zip(te,clf.predict_proba(np.clip((Xte-mu)/sd,-2.5,2.5))[:,1]): res[x['pk']]=float(p)
        return res
    OOF={a:oof(a) for a in (15,16,17)}; pks=[x['pk'] for x in rows]; Y={x['pk']:x['y'] for x in rows}; XR={x['pk']:x for x in rows}
    G=lambda x,a: int(best(labs_to(x,a))>=3)          # calibrate U18/WNT players separately from everyone else
    GR={(a,g):[k for k in pks if G(XR[k],a)==g] for a in (15,16,17) for g in (0,1)}
    CAL={(a,g):IsotonicRegression(y_min=0.02,y_max=0.99 if g else 0.95,out_of_bounds='clip').fit([OOF[a][k] for k in GR[(a,g)]],[Y[k] for k in GR[(a,g)]]) for (a,g) in GR if len(GR[(a,g)])>=5}
    cal=lambda a,s,g=0: float(CAL[(a,g)].predict([s])[0])
    P17c={k:cal(17,OOF[17][k],G(XR[k],17)) for k in pks}
    # profile cells: the band comes from players with the SAME kind of evidence (camp level + camp-performance quartile at the level that matters at this age)
    def pbucket(x,a):
        lv='U15' if a<=15 else 'U16-17'; v=[pc for (yr,l,pc,zz) in usah2.get(x['pk'],[]) if l==lv and yr-x['by']<=a]
        if not v: return 0
        pc=max(v); return 3 if pc>=.75 else 2 if pc>=.25 else 1
    def cellkey(x,a,lvl):
        b=best(labs_to(x,a))
        if b>=3: return (1,)
        return (0,b,pbucket(x,a)) if lvl==2 else (0,b) if lvl==1 else (0,)
    CELL=C.defaultdict(list)
    for k in pks:
        for a in (15,16,17):
            for lvl in (2,1,0): CELL[(a,lvl,cellkey(XR[k],a,lvl))].append(k)
    KN=60; Z=1.0364        # ~70% interval
    PW={0:'no performance data',1:'bottom-quartile performance',2:'mid-quartile performance',3:'top-quartile performance'}
    def cell_desc(x,a,key):
        if key==(1,): return 'a U18/WNT selection'
        b=key[1] if len(key)>1 else 0; lab=['no camp selection yet','U15 camp','U16–17 camp'][min(b,2)]
        return lab+((', '+PW[key[2]]) if len(key)>2 and key[2] else '')
    def band(age,s,x):
        for lvl in (2,1,0):
            key=cellkey(x,age,lvl); ks=CELL[(age,lvl,key)]
            if len(ks)>=20 or lvl==0 or (key==(1,) and len(ks)>=8): break
        arr=np.array([OOF[age][k] for k in ks]); idx=np.argsort(np.abs(arr-s))[:KN]; ys=np.array([Y[ks[i]] for i in idx]); n=len(ys); ph=ys.mean()
        den=1+Z**2/n; cen=(ph+Z**2/(2*n))/den; half=Z*math.sqrt(ph*(1-ph)/n+Z**2/(4*n*n))/den
        lo,hi=cen-half,cen+half                              # statistical uncertainty of the observed rate among similar players
        if age==15 or (age==16 and best(labs_to(x,16))<2):   # + how far similar players' estimates moved once U16-17 information arrived
            q=[P17c[ks[i]] for i in idx]; lo=min(lo,float(np.percentile(q,15))); hi=max(hi,float(np.percentile(q,85)))
        return lo,hi,cell_desc(x,age,key),len(ks),int(sum(Y[k] for k in ks))
    def scale(c,b):
        if b>=3: return 'Near-certain'
        return 'Very likely' if c>=.75 else 'Likely' if c>=.55 else 'Toss-up' if c>=.35 else 'Unlikely' if c>=.15 else 'Long shot'
    SCALE=['Near-certain','Very likely','Likely','Toss-up','Unlikely','Long shot']
    bt={a:{s:[0,0] for s in SCALE} for a in (15,16,17)}
    for a in (15,16,17):
        for k in pks:
            x=XR[k]; s=scale(cal(a,OOF[a][k],G(x,a)),best(labs_to(x,a))); bt[a][s][0]+=1; bt[a][s][1]+=Y[k]
    print('BACK-TEST (n, share who went D1) by age and rating')
    for a in (15,16,17): print(' age',a,{s:(v[0],round(v[1]/v[0],2) if v[0] else None) for s,v in bt[a].items()})
    CLUBN={}
    for x in rows:
        if x['club']: a_=CLUBN.setdefault(x['club'],[0,0]); a_[0]+=x['y']; a_[1]+=1
    def strength(v): a_=abs(v); return 3 if a_>=.8 else 2 if a_>=.4 else 1 if a_>=.12 else 0
    def sgn(v): return '+' if v>=.12 else '-' if v<=-.12 else '0'
    NM={'U15':'U15','U1617':'U16–17','U18':'U18','WNT':'WNT','WNT-C':'WNT-C'}
    def camp_text(x,age):
        d=C.OrderedDict()
        for a_,l in x['labs']:
            if a_<=age and l in RANK: d.setdefault(l,[]).append(x['by']+a_)
        if not d: return 'No USA Hockey camp selection yet','No camps yet'
        full='Camps: '+' · '.join(NM[l]+' ('+', '.join(map(str,y))+')' for l,y in d.items())
        top=max(d,key=lambda l:RANK[l]); n=len(d[top]); short=NM[top]+(' ×%d'%n if n>1 else (' only' if top=='U15' else ' camp'))
        return full,short
    QW=[(.75,'top quartile'),(.5,'2nd quartile (above median)'),(.25,'3rd quartile (below median)'),(0,'bottom quartile')]
    def qword(pc): return next(w for t,w in QW if pc>=t)
    def factors(x,age,mod,f,cr):
        z=np.clip((np.array(f,float)-mod['mu'])/mod['sd'],-2.5,2.5); c=z*mod['clf'].coef_[0]; nm=mod['names']; b=best(labs_to(x,age)); out=[]
        cv=sum(c[i] for i,n in enumerate(nm) if n.startswith('camp') or n=='n16'); full,short=camp_text(x,age)
        if b>=3: out.append(['Camp selection','+',3,'Selected to a U18/WNT camp — '+full[7:]+'. Players with this almost always play D1.',short,'Solid'])
        elif not b and age<=15: out.append(['Camp selection','0',0,'No USA Hockey camp selection yet (not yet eligible for U16–17)',short,'Thin'])
        else: out.append(['Camp selection',sgn(cv),strength(cv),full+('' if b else ' — no national-camp track record yet'),short,'Solid' if b>=2 else ('Thin' if b==1 else 'Moderate')])
        cm=[(l,pc,yr) for (yr,l,pc,zz) in usah2.get(x['pk'],[]) if yr-x['by']<=age]
        p17=[(pc,yr) for l,pc,yr in cm if l=='U16-17']; p15=[(pc,yr) for l,pc,yr in cm if l=='U15']
        cp=sum(c[i] for i,n in enumerate(nm) if n in('pc1617','q4','pc15','usah?'))
        if p17: pc,yr=max(p17); out.append(['Camp performance',sgn(cp),strength(cp),'U16–17 camp ('+str(yr)+'): %s of the camp pool. One camp is a noisy read.'%qword(pc),qword(pc).split(' (')[0]+' at camp','Solid' if pc>=.75 else 'Moderate'])
        elif p15: pc,yr=max(p15); out.append(['Camp performance',sgn(cp),strength(cp),'U15 camp ('+str(yr)+'): %s of the camp pool. U15 performance is only a weak signal.'%qword(pc),'U15 camp: '+qword(pc).split(' (')[0],'Thin'])
        else: out.append(['Camp performance','0',0,'No camp performance data yet','no camp perf',''])
        if x['club']:
            kn=CLUBN.get(x['club']); cc=c[nm.index('club')]+(c[nm.index('club*camp')] if 'club*camp' in nm else 0)
            t=x['club']+': '+(('%d of %d tracked players from this club went D1%s'%(kn[0],kn[1],'' if kn[0]==kn[1] else ' (exposure helps, not everyone makes it)')) if kn and kn[1]>=8 else 'small sample, so little pipeline history')
            out.append(['Club exposure',sgn(cc),strength(cc),t,x['club']+(' (%d/%d D1)'%(kn[0],kn[1]) if kn and kn[1]>=8 else ''),'Solid' if kn and kn[1]>=15 else ('Moderate' if kn and kn[1]>=8 else 'Thin')])
        rk=teamrank.get(x['pk'],(0,None))[1]
        if rk is not None and rk<=25:
            ct=c[nm.index('mhr10')]+c[nm.index('mhr25')]; out.append(['Team strength',sgn(ct),strength(ct),'Team ranked #%d in MHR at its level (exposure, not a guarantee)'%rk,'MHR #%d team'%rk,'Moderate'])
        hz=hubz.get(x['pk'])
        if hz and (hz[1]<=1 if age<=17 else True):
            ch=c[nm.index('hub')]+c[nm.index('hub?')]; w='above' if hz[0]>.3 else 'below' if hz[0]<-.3 else 'in line with'
            out.append(['Game data (TPE)',sgn(ch),strength(ch),'Tracked-game stats are %s same-level peers'%w,'game stats '+w.replace(' same-level',''),'Moderate'])
        cpz=c[nm.index('pos:D')]
        if abs(cpz)>=.12: out.append(['Position',sgn(cpz),strength(cpz),'Defense' if x['pos']=='D' else (x['pos'] or ''),'','Moderate'])
        return out
    def infolvl(x,age):
        has17=any(l=='U16-17' for (yr,l,pc,zz) in usah2.get(x['pk'],[]) if yr-x['by']<=age)
        v=min(2,(age-15)+(1 if has17 else 0)); lab=['Low','Medium','High'][v]
        if age<=15: note='Born %d: only U15-level camp markers exist. U16–17 selection and camp performance are not known yet, so this can move a lot.'%x['by']
        elif age==16: note='Born %d: first U16–17 selection and camp performance are known. One look is informative but can be noisy.'%x['by']
        else: note='Camp history is largely complete.'
        return lab,note
    out=[]; SEASON=2026; seen=set(x['pk'] for x in rows)
    for pk in pop:
        p=M.get(pk)
        if not p or p.get('Country')!='US' or not isinstance(p.get('BirthYr'),int) or not (2007<=p['BirthYr']<=2011): continue
        by=p['BirthYr']; age=min(17,max(15,SEASON-by))
        col=p.get('College'); cm='D1' if col in d1 else ('other' if col else '')
        x=dict(pk=pk,by=by,pos=p.get('Position'),y=0,tier=None,labs=slots(p,by),club=(clubof[pk].most_common(1)[0][0] if clubof.get(pk) else None))
        mod=mods[age]; f,names,cr=design(x,age,SETS,rows,pk in seen)
        s=float(mod['clf'].predict_proba(np.clip((np.array(f,float)-mod['mu'])/mod['sd'],-2.5,2.5).reshape(1,-1))[0,1])
        b=best(labs_to(x,age)); g_=G(x,age); pc=cal(age,s,g_); lo,hi,cdesc,cn,ck=band(age,s,x); lo=min(lo,pc); hi=max(hi,pc)
        tf,_,_=design(x,17,['club','usah'],rows,pk in seen)
        tp=tclf.predict_proba(np.clip((np.array(tf,float)-tmu)/tsd,-2.5,2.5).reshape(1,-1))[0]
        fa=factors(x,age,mod,f,cr); drv=[a_[4] for a_ in sorted([a_ for a_ in fa if a_[2]>0 or a_[0]=='Camp selection'],key=lambda a_:-a_[2]) if a_[4]][:3]
        il,note=infolvl(x,age); bwhy='Players with only this camp evidence (%s): %d of %d back-tested went D1. Club, team and other factors move a player up or down from there.'%(cdesc,ck,cn)
        out.append([pk,p['Name'],by,x['pos'],age,round(pc,2),cm,col or '',(d1[col]['tier'] if col in d1 else ''),[round(float(v),3) for v in tp],drv,x['club'] or '',
                    (p['Grad'] if isinstance(p.get('Grad'),int) else by+18),scale(pc,b),round(lo,2),round(hi,2),il,note,fa,bwhy])
    meta=dict(built=datetime.date.today().isoformat(),note='Rating scale + range for US players in the recruited pool; one model per as-of age, trained on 2006/2007 birth years.',
              fields=['pk','name','by','pos','asofAge','centre','committedTo','college','tier','tierProbs(1-4|D1)','drivers','club','gradYr','scale','lo','hi','info','infoNote','factors[group,sign,strength,text,short,certainty]','bandWhy'],
              n=len(out),train=len(rows),cohorts=COH,scale=SCALE,backtest={str(a):{s:v for s,v in bt[a].items()} for a in bt})
    json.dump(dict(meta=meta,rows=out),open(os.path.join(D,'..','hockeyfile','d1prob.json'),'w'),separators=(',',':'))
    print('wrote d1prob.json',len(out),'players')
    for a in (15,16,17):
        w=[r[15]-r[14] for r in out if r[4]==a]; print('age',a,'n',len(w),'mean band width %.2f'%np.mean(w))
    print(C.Counter(r[13] for r in out)); print(C.Counter((r[4],r[16]) for r in out))
