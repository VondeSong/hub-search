"""Owned real24h process workload; progress is never a completion receipt."""
from native_recovery import *
import argparse
import run as transport

SOAK=AREA/'soak'
PROGRESS=OUT/'soak-progress.json'

def register():
    r=read(OUT/'result.json');assert r['status']=='completed' and r['passed'] and not r['residual']
    assert digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs')==read(OUT/'method.json')['rustSha256']
    SOAK.mkdir(exist_ok=False)
    save(OUT/'soak-contract.json',{'at':now(),'sourceSha256':digest(__file__),'recoverySha256':digest(OUT/'result.json'),
       'runtimeSourceSha256':digest(Path(__file__).with_name('native_recovery.py')),'adapterSourceSha256':digest(Path(__file__).with_name('lifecycle_native.py')),
       'durationSeconds':86400,'cadenceSeconds':60,'cycles':1441,'maxGapSeconds':120,'ownedDiskCeilingGiB':8,'freeDiskFloorGiB':10,
       'workload':'Same100notes/5100chunks. Every minute update one note revision, actual query, identical retry and actual query. Every10cycles delete/recreate a separate note; full state checked after each action. Every cycle check cross-project exclusion. No new remote LLM calls.',
       'gates':'Actual postACK lookup<=5s; all states,versions,deletes,retries/scopes correct; sample RSS<=1536MiB; last60cycle RSS median<=first15cycle median*1.10; elapsed>=86400s and1441cycles; gap>120s interrupts/fails continuity; final close/restart first lookup<=10s and complete state matches.',
       'coverage':'Test-only native storage/vector runtime, real Hub readers/index jobs and Rust embeddings. Not whole app/clean install, power loss, concurrent external editing, model quality or backend adoption.',
       'ownership':'One exclusive run.started marker and recorded PID/createTime. No auto-restart. STOP file requests cancellation. Process/OS interruption cannot count as24h pass. Hourly task checks progress only.'})
    print('Soak contract registered after all recovery gates passed.')

def exercise():
    contract=read(OUT/'soak-contract.json');assert digest(__file__)==contract['sourceSha256']
    assert digest(Path(__file__).with_name('native_recovery.py'))==contract['runtimeSourceSha256']
    assert digest(Path(__file__).with_name('lifecycle_native.py'))==contract['adapterSourceSha256']
    save(SOAK/'run.started',{'at':now(),'pid':os.getpid(),'createTime':psutil.Process().create_time()})
    result={'startedAt':now(),'status':'preparing','cycles':0,'backendSelected':False};client=None;rss=[];previous=None
    expected={r['id']:r['content'] for r in corpus()}
    try:
        state=SOAK/'state';shutil.copytree(AREA/'seed',state)
        client=start(state);assert matches(client.snapshot(),expected)
        began=time.perf_counter();result.update(status='running',measurementStartedAt=now())
        for cycle in range(1441):
            due=began+cycle*60
            while time.perf_counter()<due:
                if (SOAK/'STOP').exists():raise InterruptedError('User STOP requested')
                time.sleep(min(1,max(0,due-time.perf_counter())))
            current=time.perf_counter()
            if previous is not None and current-previous>120:raise RuntimeError('Sampling gap>120s: cannot certify continuous24h')
            previous=current
            number=cycle%20;mid=f'hbm-op-{number:03}';revision=cycle+1;content=body(number,revision)
            checks=[write_checked(client,mid,content,expected,revision),write_checked(client,mid,content,expected,revision)]
            if cycle%10==0:
                checks.append(delete_checked(client,'hbm-op-060',expected))
                checks.append(write_checked(client,'hbm-op-060',body(60),expected))
            h=client.search(body(80)[:230],project='left',lexical='核对口令是HBMOP080S00V0')
            scope=not set(f'hbm-op-{n:03}' for n in range(80,100)).intersection(h['vectorIds']+h['lexicalIds'])
            usage=client.usage();rss.append(usage['rssMiB'])
            if cycle%60==0:
                result['ownedDiskBytes']=sum(p.stat().st_size for p in SOAK.rglob('*') if p.is_file())
                result['freeDiskBytes']=shutil.disk_usage(SOAK).free
                assert result['ownedDiskBytes']<=8*1024**3 and result['freeDiskBytes']>=10*1024**3,'Disk gate failed'
            row={'cycle':cycle,'at':now(),'elapsedSeconds':time.perf_counter()-began,'checks':checks,'scopePassed':scope,'resources':usage,
                 'passed':all(c['passed'] for c in checks) and scope and usage['rssMiB']<=1536}
            with (SOAK/'cycles.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n');f.flush()
            result.update(cycles=cycle+1,lastAt=row['at'],elapsedSeconds=row['elapsedSeconds'],lastCyclePassed=row['passed'],rssMiB=rss[-1],peakRssMiB=max(rss),owned=usage['members'])
            transport.save(PROGRESS,result)
            assert row['passed'],'Workload gate failed; do not continue as a passing soak'
        import statistics
        result['warmBaselineRssMiB']=statistics.median(rss[:15]);result['finalMedianRssMiB']=statistics.median(rss[-60:])
        result['growthPercent']=(result['finalMedianRssMiB']/result['warmBaselineRssMiB']-1)*100
        assert result['growthPercent']<=10,'Warm memory growth exceeds10%'
        assert result['elapsedSeconds']>=86400
        assert not client.close();client=None
        restart=time.perf_counter();client=start(state);assert lookup(client,'hbm-op-060',body(60))
        result['restartFirstUsableMs']=(time.perf_counter()-restart)*1000
        assert result['restartFirstUsableMs']<=10000 and matches(client.snapshot(),expected)
        result.update(status='completed',passed=True)
    except BaseException as e:
        result.update(status='cancelled' if isinstance(e,InterruptedError) else 'failed',passed=False,errorType=type(e).__name__,error=str(e)[:600])
    finally:
        result['residual']=client.close() if client else []
        if result['residual']:result.update(status='failed',passed=False,error='Residual owned processes')
        result['finishedAt']=now();save(OUT/'soak-result.json',result);transport.save(PROGRESS,result)
    print(json.dumps({'status':result['status'],'cycles':result['cycles'],'passed':result.get('passed',False)}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['register','run']);a=p.parse_args()
    register() if a.phase=='register' else exercise()
