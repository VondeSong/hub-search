"""New uninterrupted observation; strict failures retained while correct slow operations continue."""
from native_recovery import *
import native_soak_v3 as phases
import run as transport
import statistics,sys

REPORT=ROOT/'artifacts/hbm-00-native-soak-v4-20261019'
STATE=AREA/'soak-v4'
PRIOR=ROOT/'artifacts/hbm-00-native-soak-v3-20261019'

def register():
    assert not REPORT.exists() and not STATE.exists()
    old=read(PRIOR/'soak-result.json');assert old['status']=='failed'
    ownership=read(AREA/'soak-v3/run.started')
    try:assert abs(psutil.Process(ownership['pid']).create_time()-ownership['createTime'])>.01,'Prior controller still alive'
    except psutil.NoSuchProcess:pass
    r=read(PRIOR/'native-harness-v2.json')
    assert digest(r['executable'])==r['binarySha256'] and digest(r['executable']+'.manifest')==r['manifestSha256']
    REPORT.mkdir();STATE.mkdir()
    c=read(PRIOR/'soak-contract.json')
    c.update(at=now(),sourceSha256=digest(__file__),phaseSourceSha256=digest(phases.__file__),
       priorFailedResultSha256=digest(PRIOR/'soak-result.json'),priorElapsedSeconds=old['elapsedSeconds'],
       continuationPolicy='Correct completed operations above5s remain strict failures but observation continues. Incorrect state/query/scope, crash, noncompletion within existing180s RPC bound, disk unsafe or gap>120s stops. RSS limit/growth breaches recorded strict failures. No automatic restart.',
       accounting='New86400s/1441samples. Prior run time only separate cumulative observation; never stitched into continuous24h.',
       preflight='Four operations on separate copy, correctness required; timing failures retained but not stop criteria.',
       reason='User explicitly authorized new observation with soft timing failures; strict old gates unchanged.')
    save(REPORT/'soak-contract.json',c);save(REPORT/'native-harness-v2.json',r)

def setup():
    c=read(REPORT/'soak-contract.json')
    assert digest(__file__)==c['sourceSha256'] and digest(phases.__file__)==c['phaseSourceSha256']
    assert digest(PRIOR/'soak-result.json')==c['priorFailedResultSha256']
    assert digest(Path(__file__).with_name('lifecycle_native.py'))==c['adapterSourceSha256']
    assert c['seedFiles']=={str(p.relative_to(AREA/'seed')):digest(p) for p in (AREA/'seed').rglob('*') if p.is_file()}
    native.REPORTS=REPORT;phases.SEQUENCE=0
    return c

def correct(row):return row['ready']['ready'] and row.get('queryFound',row.get('absent',False))

def actions(client,cycle,expected):
    n=cycle%20;rev=cycle+1;mid=f'hbm-op-{n:03}';content=body(n,rev)
    rows=[]
    for _ in range(2):
        row=phases.write_checked_v3(client,mid,content,expected,rev);rows.append(row)
        if not correct(row):raise RuntimeError('Incorrect write; see operation phase journal')
    if cycle%10==0:
        row=phases.delete_checked_v3(client,'hbm-op-060',expected);rows.append(row)
        if not correct(row):raise RuntimeError('Incorrect deletion; see operation phase journal')
        row=phases.write_checked_v3(client,'hbm-op-060',body(60),expected);rows.append(row)
        if not correct(row):raise RuntimeError('Incorrect recreation; see operation phase journal')
    return rows

def preflight():
    setup();target=STATE/'preflight';phases.JOURNAL=STATE/'preflight-phases.jsonl'
    shutil.copytree(AREA/'seed',target);client=None;r={'at':now()}
    try:
        client=start(target);expected={x['id']:x['content'] for x in corpus()};assert matches(client.snapshot(),expected)
        rows=actions(client,0,expected);r.update(correct=all(map(correct,rows)),strictPassed=all(x['passed'] for x in rows),checks=rows)
    except BaseException as e:r.update(correct=False,error=repr(e))
    finally:
        r['residual']=client.close() if client else [];save(REPORT/'preflight.json',r)
    print(json.dumps(r),flush=True)

def run():
    c=setup();pre=read(REPORT/'preflight.json');assert pre['correct'] and not pre['residual']
    save(STATE/'run.started',{'at':now(),'pid':os.getpid(),'createTime':psutil.Process().create_time()})
    phases.JOURNAL=STATE/'phases.jsonl';client=None;rss=[];began=None;previous=None
    result={'startedAt':now(),'status':'preparing','cycles':0,'strictFailures':[],'timingFailureCount':0,'backendSelected':False,
            'priorObservedSeconds':c['priorElapsedSeconds'],'continuity':'new run only; previous time excluded'}
    expected={x['id']:x['content'] for x in corpus()}
    try:
        state=STATE/'state';shutil.copytree(AREA/'seed',state);client=start(state);assert matches(client.snapshot(),expected)
        began=time.perf_counter();result.update(status='running',measurementStartedAt=now())
        for cycle in range(1441):
            due=began+cycle*60
            while time.perf_counter()<due:
                if (STATE/'STOP').exists():raise InterruptedError('User STOP requested')
                time.sleep(min(1,max(0,due-time.perf_counter())))
            current=time.perf_counter()
            if previous is not None and current-previous>120:raise RuntimeError('Sampling gap>120s; continuity interrupted')
            previous=current
            rows=actions(client,cycle,expected)
            h=client.search(body(80)[:230],project='left',lexical='核对口令是HBMOP080S00V0')
            scope=not set(f'hbm-op-{n:03}' for n in range(80,100)).intersection(h['vectorIds']+h['lexicalIds'])
            usage=client.usage();rss.append(usage['rssMiB'])
            failures=[{'cycle':cycle,'operationId':x['operationId'],'kind':'postAckOver5s','ms':x['queryAfterAckMs']} for x in rows if not x['passed']]
            result['timingFailureCount']+=len(failures)
            if usage['rssMiB']>1536:failures.append({'cycle':cycle,'kind':'rssOver1536MiB','value':usage['rssMiB']})
            result['strictFailures'].extend(failures)
            row={'cycle':cycle,'at':now(),'elapsedSeconds':time.perf_counter()-began,'checks':rows,'scopePassed':scope,'resources':usage,'passed':not failures and scope}
            with (STATE/'cycles.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n');f.flush()
            result.update(cycles=cycle+1,lastAt=row['at'],elapsedSeconds=row['elapsedSeconds'],lastCyclePassed=row['passed'],rssMiB=rss[-1],peakRssMiB=max(rss),owned=usage['members'])
            transport.save(REPORT/'soak-progress.json',result)
            assert scope,'Incorrect project scope'
            if cycle%60==0:
                result['ownedDiskBytes']=sum(p.stat().st_size for p in STATE.rglob('*') if p.is_file());result['freeDiskBytes']=shutil.disk_usage(STATE).free
                assert result['ownedDiskBytes']<=8*1024**3 and result['freeDiskBytes']>=10*1024**3,'Unsafe disk resource gate'
        result['warmBaselineRssMiB']=statistics.median(rss[:15]);result['finalMedianRssMiB']=statistics.median(rss[-60:])
        result['growthPercent']=(result['finalMedianRssMiB']/result['warmBaselineRssMiB']-1)*100
        if result['growthPercent']>10:result['strictFailures'].append({'kind':'memoryGrowthOver10Percent','value':result['growthPercent']})
        assert result['elapsedSeconds']>=86400
        assert not client.close();client=None
        t=time.perf_counter();client=start(state);assert lookup(client,'hbm-op-060',body(60))
        result['restartFirstUsableMs']=(time.perf_counter()-t)*1000;assert matches(client.snapshot(),expected)
        if result['restartFirstUsableMs']>10000:result['strictFailures'].append({'kind':'restartOver10s','ms':result['restartFirstUsableMs']})
        result.update(status='completed',observationCompleted=True,passed=not result['strictFailures'])
    except BaseException as e:
        result.update(status='cancelled' if isinstance(e,InterruptedError) else 'failed',passed=False,observationCompleted=False,error=repr(e))
    finally:
        result['actualRunSeconds']=(time.perf_counter()-began) if began else 0
        result['residual']=client.close() if client else []
        if result['residual']:result.update(status='failed',passed=False)
        result['oldFailureUnchanged']=digest(PRIOR/'soak-result.json')==c['priorFailedResultSha256']
        result['finishedAt']=now();save(REPORT/'soak-result.json',result);transport.save(REPORT/'soak-progress.json',result)
    print(json.dumps({k:result.get(k) for k in ['status','cycles','passed','timingFailureCount','error']}),flush=True)

if __name__=='__main__':{'register':register,'preflight':preflight,'run':run}[sys.argv[1]]()
