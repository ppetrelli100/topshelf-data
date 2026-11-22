"""d1_rates.py -- first-pass empirical D1 rates for the planned D1 probability model (Nov 2026).
US only. Population = US players (master BirthYr 2006/2007) on a US 16U/19U roster (rosters.json) whose team is
MHR top-25 that season, OR whose team has >=1 commit, OR who attended a USAH camp (ndc.json).
Outcome = master College: in d1.json -> D1 (+tier), other college -> 'other', blank -> 'none'.
Camp markers as-of age 15/16/17 come from master Fresh/Soph/Jr. Prints rates by best camp to date.
Run: python3 d1_rates.py   (reads the JSON files next to this folder's parent; no writes).
"""
import json,re,os,collections as C
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

m=json.load(open(D+'master.json')); d1=json.load(open(D+'d1.json'))
M={x['PersonKey']:x for x in m}
# roster population
lvl_ok={'16U','19U'}
pop={}  # pk -> why
for s,teams in r.items():
    for t in teams:
        if t['country']!='US' or t['lvl'] not in lv: continue
        hit=match(norm(t['team']),rank.get((s,lv[t['lvl']]),{}))
        k=sum(p['pk'] in cs for p in t['players'])
        top=bool(hit and hit[0]<=25)
        if top or k:
            for p in t['players']: pop.setdefault(p['pk'],set()).add('top25' if top else 'committeam')
ndc=json.load(open(D+'ndc.json'))
for x in ndc:
    if x.get('Country')=='US' or x.get('STATE'): pop.setdefault(x['personkey'],set()).add('camp')
RANK={'U15':1,'U1617':2,'U18':3,'WNT':4,'WNT-C':4}
def best(labs):
    b=0
    for l in labs:
        b=max(b,RANK.get(l,0))
    return b
NAME={0:'none',1:'U15',2:'U1617',3:'U18',4:'WNT'}
rows=[]
for pk,why in pop.items():
    p=M.get(pk)
    if not p or p.get('Country')!='US': continue
    by=p.get('BirthYr')
    if by not in (2006,2007): continue
    col=p.get('College'); 
    out='D1' if col in d1 else ('other' if col else 'none')
    tier=d1[col]['tier'] if col in d1 else None
    labs=[p.get('Fresh'),p.get('Soph'),p.get('Jr')]   # ages 15,16,17 camp years
    n1617=sum(1 for l in labs if l=='U1617')
    rows.append(dict(pk=pk,by=by,pos=p.get('Position'),out=out,tier=tier,labs=labs,why=why,n1617=n1617))
print('population',len(rows),C.Counter(r_['by'] for r_ in rows),C.Counter(r_['out'] for r_ in rows))
for by in (2006,2007):
    print('== birthyear',by,'N',sum(1 for x in rows if x['by']==by),'D1%',round(100*sum(x['out']=='D1' for x in rows if x['by']==by)/max(1,sum(1 for x in rows if x['by']==by)),1))
    for age,k in ((15,1),(16,2),(17,3)):
        g=C.defaultdict(list)
        for x in rows:
            if x['by']!=by: continue
            g[NAME[best(x['labs'][:k])]].append(x)
        print(' as-of age',age)
        for lab in ['none','U15','U1617','U18','WNT']:
            xs=g.get(lab,[]); 
            if not xs: continue
            d=sum(x['out']=='D1' for x in xs); t=C.Counter(x['tier'] for x in xs if x['tier'])
            print('   %-6s n=%4d D1=%5.1f%%  tiers(1/2/3/4)=%s'%(lab,len(xs),100*d/len(xs),'/'.join(str(t.get(k_,0)) for k_ in '1234')))
    # U1617 count at age 17
    g=C.defaultdict(list)
    for x in rows:
        if x['by']==by and best(x['labs'])<=2: g[x['n1617']].append(x)
    print(' U1617 appearances (peak<=U1617):',{k_:(len(v),round(100*sum(y['out']=='D1' for y in v)/len(v),1)) for k_,v in sorted(g.items())})
