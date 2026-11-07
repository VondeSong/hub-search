"""HBM-00 relocation/startup/restore/resource-failure component evidence only."""
from native_recovery import *
import sys, platform

REPORT=ROOT/'artifacts/hbm-00-deployment-components-20261019'
HOME=ROOT/'.local/hbm-00/deployment-components-20261019'
RUN=HOME/'lifecycle-20261018'
PREV=ROOT/'artifacts/hbm-00-native-soak-v3-20261019'
SEED=AREA/'seed'
FINAL=WORK/'native-formal-v2'
BUNDLE=OLD/'rust-runtime/bundle'

def manifest(root):
    return {str(p.relative_to(root)): {'sha256':digest(p),'bytes':p.stat().st_size} for p in root.rglob('*') if p.is_file()}

def facts(state):
    with sqlite3.connect((state/'craft-search.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as db:
        hashes={}
        for name in ['documents','content_items','hbm_vectors']:
            h=hashlib.sha256();n=0
            for row in db.execute('SELECT * FROM '+name+' ORDER BY rowid'):
                h.update(repr(row).encode('utf-8'));n+=1
            hashes[name]={'rows':n,'sha256':h.hexdigest()}
        return {'tables':hashes,'integrity':db.execute('PRAGMA integrity_check').fetchone()[0]}

def register():
    assert not REPORT.exists() and not HOME.exists()
    previous=read(ROOT/'artifacts/hbm-00-lifecycle-20261018/native-formal-v2-result.json')
    assert previous['allLifecycleGatesPassed'] and previous['residual']==[]
    receipt=read(PREV/'native-harness-v2.json')
    assert digest(receipt['executable'])==receipt['binarySha256']
    assert digest(receipt['executable']+'.manifest')==receipt['manifestSha256']
    assert shutil.disk_usage(ROOT).free>10*1024**3
    REPORT.mkdir();RUN.mkdir(parents=True);(RUN/'tmp').mkdir()
    save(REPORT/'contract.json',{'at':now(),'driverSha256':digest(__file__),
        'environment':{'platform':platform.platform(),'cpuCount':os.cpu_count(),'physicalMemory':psutil.virtual_memory().total},
        'scope':'D02 five fresh launches of relocated native QA resources; D04 closed-state restore at Unicode/space path; D03 missing/corrupt model subcases only. Developer host component evidence, not clean-install/offline qualification.',
        'budgetSeconds':300,'rpcWaitSeconds':30,'coldLimitMs':10000,'postAckLimitMs':5000,
        'D02':'100notes5100chunks seed, five fresh processes; first target query<=10s, full state matches, no residual. OS caches retained.',
        'D04':'Reuse prior completed60-operation lineage (20update/delete/replace+retries),80notes4080vectors; close-copy backup, copy to new Unicode/space root, verify all hashes, query all40deleted and20successors plus8retained representatives. One new update+retry<=5s on restored root, verify closed restart. Not a fresh repeat of60operations or formal memory restore.',
        'D03':'Independent full seed/model copies; missing model and corrupt model header must explicitly fail startup within30s, leave logical body/vector state unchanged, then resource restoration must enable actual query<=10s. No firewall changes; offline operation not claimed.',
        'D01_D05_D06_D07':'Not executed: clean environment/full candidate pack; two upgrade artifacts; tombstone replay consumer; supported uninstaller unavailable.',
        'stop':'One run per case, stop on unexpected functional/time failure; no tuning/auto rerun, no24h/model calls/backend adoption. Only new owned directories mutate. Keep all evidence.',
        'seed':manifest(SEED),'finalState':manifest(FINAL),'resources':manifest(BUNDLE),
        'priorLifecycleSha256':digest(ROOT/'artifacts/hbm-00-lifecycle-20261018/native-formal-v2-result.json'),
        'priorSoakResultSha256':digest(PREV/'soak-result.json'),
        'receipt':receipt,'qaDependencies':'Python controller and BM pure chunker remain on developer host; not a self-contained Hub package.'})
    print('Frozen five launches, restore, two resource faults;300s run budget.')

def main():
    c=read(REPORT/'contract.json');assert c['driverSha256']==digest(__file__)
    assert not (RUN/'run.started').exists()
    started=now();save(RUN/'run.started',{'at':started,'pid':os.getpid(),'createTime':psutil.Process().create_time()})
    prep=time.perf_counter();assert manifest(SEED)==c['seed'] and manifest(FINAL)==c['finalState']
    package=HOME/'resources';shutil.copytree(BUNDLE,package/'rust-runtime/bundle')
    (package/'harness').mkdir();receipt=dict(c['receipt'])
    exe=package/'harness/tests.exe';shutil.copy2(receipt['executable'],exe);shutil.copy2(receipt['executable']+'.manifest',str(exe)+'.manifest')
    receipt['executable']=str(exe);save(REPORT/'native-harness-v2.json',receipt)
    native.REPORTS=REPORT;native.OLD=package;native.WORK=RUN
    shutil.copytree(SEED,RUN/'startup')
    save(REPORT/'resource-manifest.json',manifest(package))
    r={'startedAt':started,'status':'running','startup':[],'faults':[],'preparationMs':(time.perf_counter()-prep)*1000}
    client=None;began=time.perf_counter();deadline=began+300
    original=native.Native.receive
    def receive(self):
        remain=deadline-time.perf_counter()
        if remain<=0:raise TimeoutError('Fixed300s budget exceeded')
        value=self.queue.get(timeout=min(30,remain))
        if value is None:raise RuntimeError('Native RPC exited; inspect owned stderr')
        if isinstance(value,Exception):raise value
        return value
    native.Native.receive=receive
    baseline={v['id']:v['content'] for v in corpus()}
    try:
        for i in range(5):
            t=time.perf_counter();client=start(RUN/'startup');found=lookup(client,'hbm-op-000',body(0))
            row={'firstUsableMs':(time.perf_counter()-t)*1000,'found':found,'resources':client.usage()}
            row['wholeState']=matches(client.snapshot(),baseline)
            row['residual']=client.close();client=None
            row['passed']=found and row['wholeState'] and row['firstUsableMs']<=10000 and not row['residual']
            r['startup'].append(row);save(REPORT/f'startup-{i}.json',row);assert row['passed']
        print('Five relocated startup cases completed.',flush=True)
        expected=dict(baseline)
        for n in range(20):expected[f'hbm-op-{n:03}']=body(n,1)
        for n in range(20,60):expected.pop(f'hbm-op-{n:03}')
        for n in range(100,120):expected[f'hbm-op-{n:03}']=body(n)
        t=time.perf_counter();shutil.copytree(FINAL,RUN/'closed-backup');shutil.copytree(RUN/'closed-backup',RUN/'恢复 新位置')
        restore={'copyMs':(time.perf_counter()-t)*1000,'backupExact':manifest(RUN/'closed-backup')==c['finalState']}
        before=manifest(RUN/'closed-backup');t=time.perf_counter();client=start(RUN/'恢复 新位置')
        found=lookup(client,'hbm-op-000',body(0,1),revision=1)
        restore['firstUsableMs']=(time.perf_counter()-t)*1000
        snap=client.snapshot();restore.update(wholeState=matches(snap,expected),notes=len(snap['notes']),vectors=snap['vectors'])
        assert found and restore['firstUsableMs']<=10000 and restore['wholeState'] and restore['backupExact']
        checks=[]
        for n in list(range(20,60))+list(range(100,120))+[0,19,60,61,78,79,80,99]:
            mid=f'hbm-op-{n:03}';project='right' if 80<=n<100 else 'left';rev=1 if n<20 else 0
            hits=client.search(body(n,rev)[:230],project=project,lexical=f'核对口令是HBMOP{n:03}S00V{rev}')
            absent=20<=n<60
            ok=(mid not in hits['vectorIds']+hits['lexicalIds']) if absent else (mid in hits['vectorIds'] and mid in hits['lexicalIds'])
            checks.append({'id':mid,'absent':absent,'passed':ok});assert ok
        restore['queries']=checks
        restore['writes']=[write_checked(client,'hbm-op-000',body(0,2),expected,2),write_checked(client,'hbm-op-000',body(0,2),expected,2)]
        assert all(x['passed'] for x in restore['writes'])
        assert not client.close();client=None
        t=time.perf_counter();client=start(RUN/'恢复 新位置');found=lookup(client,'hbm-op-000',body(0,2),revision=2)
        restore['restartFirstUsableMs']=(time.perf_counter()-t)*1000;restore['restartStateMatches']=matches(client.snapshot(),expected)
        restore['residual']=client.close();client=None
        restore['backupUnchanged']=manifest(RUN/'closed-backup')==before
        assert found and restore['restartFirstUsableMs']<=10000 and restore['restartStateMatches'] and not restore['residual'] and restore['backupUnchanged']
        restore['passed']=True;r['restore']=restore;save(REPORT/'restore.json',restore)
        print('Restore and68actual queries completed.',flush=True)
        for mode in ['missing','corrupt']:
            owned=HOME/mode;shutil.copytree(BUNDLE,owned/'rust-runtime/bundle');state=RUN/mode;shutil.copytree(SEED,state)
            model=owned/'rust-runtime/bundle/model_optimized.onnx'
            if mode=='missing':model.rename(model.with_suffix('.withheld'))
            else:
                with model.open('r+b') as f:f.write(b'HBM-00 deliberate invalid model header\x00'*4)
            original_facts=facts(state);native.OLD=owned;t=time.perf_counter();failure=None
            try:client=start(state)
            except Exception as e:failure=repr(e)
            elapsed=(time.perf_counter()-t)*1000
            if client is not None:client.close();client=None
            fault={'mode':mode,'startupError':failure,'failureMs':elapsed,'logicalDataUnchanged':facts(state)==original_facts,
                   'stderrNonempty':(state/'native.stderr.log').stat().st_size>0}
            assert failure and elapsed<=30000 and fault['logicalDataUnchanged'] and fault['stderrNonempty'],'Resource failure contract not met'
            shutil.copy2(BUNDLE/'model_optimized.onnx',model)
            t=time.perf_counter();client=start(state);found=lookup(client,'hbm-op-000',body(0));fault['restoredFirstUsableMs']=(time.perf_counter()-t)*1000
            fault['restoredWholeState']=matches(client.snapshot(),baseline);fault['residual']=client.close();client=None
            assert found and fault['restoredFirstUsableMs']<=10000 and fault['restoredWholeState'] and not fault['residual']
            fault['passed']=True;r['faults'].append(fault);save(REPORT/f'fault-{mode}.json',fault)
            print(mode+' resource failure/recovery completed.',flush=True)
        r.update(status='completed',componentCasesPassed=True)
    except BaseException as e:r.update(status='failed',error=repr(e),componentCasesPassed=False)
    finally:
        native.Native.receive=original
        r['cleanupResidual']=client.close() if client else []
        r['wallMs']=(time.perf_counter()-began)*1000
        r['originalSeedUnchanged']=manifest(SEED)==c['seed'];r['originalFinalUnchanged']=manifest(FINAL)==c['finalState']
        r['originalResourcesUnchanged']=manifest(BUNDLE)==c['resources'];r['oldFailureUnchanged']=digest(PREV/'soak-result.json')==c['priorSoakResultSha256']
        owned=[]
        for p in RUN.rglob('closed-*.json'):
            x=read(p)
            if x['at']>=started:owned.extend(x['owned'])
        r['owned']=owned;r['residual']=[]
        for m in owned:
            try:
                if abs(psutil.Process(m['pid']).create_time()-m['createTime'])<.01:r['residual'].append(m)
            except psutil.NoSuchProcess:pass
        if r['residual'] or r['cleanupResidual']:r.update(status='failed',componentCasesPassed=False)
        r['finishedAt']=now();save(REPORT/'result.json',r)
    print(json.dumps({k:r.get(k) for k in ['status','error','componentCasesPassed','wallMs','residual','oldFailureUnchanged']},ensure_ascii=False),flush=True)

if __name__=='__main__':{'register':register,'run':main}[sys.argv[1]]()
