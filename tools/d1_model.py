"""d1_model.py -- US D1 probability model (first version, Nov 2026). Writes ../d1prob.json for the playerview "D1 outlook" tab.
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
def norm(s):
    s=re.sub(r'\([^)]*\)','',s).lower()
    s=re.sub(r'\b(14u|16u|19u|u15|u18|u22|prep|jr\.?|junior|lady|girls|women|womens|hockey|club|the|major|black|blue|gold|green|navy|silver|sky|white|vegas|red|royal|elite2|\d+ ?2)\b','',s)
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
clubof=C.defaultdict(C.Counter)
for s,teams in r.items():
    for t in teams:
        if t['country']!='US' or t['lvl'] not in lv: continue
        for p in t['players']: clubof[p['pk']][t['club']]+=1
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
    if not p or p.get('Country')!='US' or p.get('BirthYr') not in (2006,2007): continue
    col=p.get('College'); out='D1' if col in d1 else ('other' if col else 'none')
    rows.append(dict(pk=pk,by=p['BirthYr'],pos=p.get('Position'),y=int(out=='D1'),tier=int(d1[col]['tier']) if col in d1 else None,
        labs=slots(p,p['BirthYr']),club=(clubof[pk].most_common(1)[0][0] if clubof.get(pk) else None)))
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
    for tr_by,te_by in ((2006,2007),(2007,2006)):
        tr=[x for x in rows if x['by']==tr_by]; te=[x for x in rows if x['by']==te_by]
        if target=='tier': tr=[x for x in tr if x['tier']]; te=[x for x in te if x['tier']]
        yv=(lambda x:x['y']) if target=='d1' else (lambda x:int(x['tier']<=2))
        base=[x for x in rows if x['by']==tr_by]   # club rates from the training cohort only
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
    if 'hub' in sets:
        hz=hubz.get(x['pk']); ok=hz and (hz[1]<=1 if age<=17 else True)
        f+=[hz[0] if ok else 0.0, 0.0 if ok else 1.0]; names+=['hub','hub?']
    if 'usah' in sets:
        cm=[(l,pc) for (yr,l,pc,z) in usah2.get(x['pk'],[]) if yr-x['by']<=age]
        p17=[pc for l,pc in cm if l=='U16-17']; p15=[pc for l,pc in cm if l=='U15']
        pc17=max(p17) if p17 else None; pc15=max(p15) if p15 else None
        f+=[(pc17-0.5) if p17 else 0.0, float(bool(p17) and pc17>=0.75), (pc15-0.5) if p15 else 0.0, 0.0 if cm else 1.0]; names+=['pc1617','q4','pc15','usah?']
    return f,names,cr
SETS=['club','hub','usah']
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
            for name,sets in (('camp',[]),('+club',['club']),('+hub',['club','hub']),('+usah',['club','usah']),('all',['club','hub','usah'])):
                a,b,_,_=run(age,sets,target); line.append('%s AUC %.3f Brier %.3f'%(name,a,b))
            print('age',age,' | '.join(line))
    for age in (15,16,17):
        a,b,p,y=run(age,['club','hub','usah'])
        print('calibration age',age,'(pred bin: n, pred, actual)')
        for lo,hi in ((0,.2),(.2,.4),(.4,.6),(.6,.8),(.8,1.01)):
            sel=(p>=lo)&(p<hi); print('   %.1f-%.1f n=%3d pred=%.2f actual=%.2f'%(lo,hi,sel.sum(),p[sel].mean() if sel.any() else 0,y[sel].mean() if sel.any() else 0))
if __name__=='__main__' and '--cv' not in sys.argv:
    mods={a:fit(a) for a in (15,16,17)}; tclf,tmu,tsd=tier_model()
    out=[]; SEASON=2026
    seen=set(x['pk'] for x in rows)
    for pk in pop:
        p=M.get(pk)
        if not p or p.get('Country')!='US' or not isinstance(p.get('BirthYr'),int) or not (2007<=p['BirthYr']<=2011): continue
        by=p['BirthYr']; age=min(17,max(15,SEASON-by))
        col=p.get('College'); cm='D1' if col in d1 else ('other' if col else '')
        x=dict(pk=pk,by=by,pos=p.get('Position'),y=0,tier=None,labs=slots(p,by),
               club=(clubof[pk].most_common(1)[0][0] if clubof.get(pk) else None))
        mod=mods[age]; f,names,cr=design(x,age,SETS,rows,pk in seen)
        pr=float(mod['clf'].predict_proba(np.clip((np.array(f,float)-mod['mu'])/mod['sd'],-2.5,2.5).reshape(1,-1))[0,1])
        if best(labs_to(x,age))<3: pr=min(pr,0.90)   # cross-validation never supported >90% without a U18/WNT selection
        tf,_,_=design(x,17,['club','usah'],rows,pk in seen)
        tp=tclf.predict_proba(np.clip((np.array(tf,float)-tmu)/tsd,-2.5,2.5).reshape(1,-1))[0]
        out.append([pk,p['Name'],by,x['pos'],age,round(pr,3),cm,col or '',(d1[col]['tier'] if col in d1 else ''),[round(float(v),3) for v in tp],why(mod,f,x,cr),x['club'] or ''])
    meta=dict(built=datetime.date.today().isoformat(),note='P(D1 | in the recruited pool, US). Trained on 2006/2007 birth years; one model per as-of age.',
              fields=['pk','name','by','pos','asofAge','pD1','committedTo','college','tier','tierProbs(1-4|D1)','why','club'],n=len(out),train=len(rows))
    json.dump(dict(meta=meta,rows=out),open(os.path.join(D,'d1prob.json'),'w'),separators=(',',':'))
    print('wrote d1prob.json',len(out),'players')
