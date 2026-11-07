"""One isolated correctness/trend diagnosis; never rescores the failed soak."""
from native_recovery import *
import statistics, math, sys

REPORT = ROOT/'artifacts/hbm-00-native-substantive-20261019'
DEST = AREA/'substantive-20261019'
SOURCE = AREA/'soak-v3/state'
PREV = ROOT/'artifacts/hbm-00-native-soak-v3-20261019'
FILES = ['src-tauri/src/lib.rs', 'src-tauri/src/search_index.rs',
         'src-tauri/src/search_index_runtime.rs', 'src-tauri/src/agent_work/memory_lifecycle_tests.rs',
         'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']

def manifest(root):
    return {str(p.relative_to(root)): digest(p) for p in root.rglob('*') if p.is_file()}

def stats(xs):
    xs = sorted(xs)
    return {'n':len(xs), 'median':statistics.median(xs),
            'p95':xs[math.ceil(.95*len(xs))-1], 'max':max(xs)}

def register():
    assert not REPORT.exists() and not DEST.exists()
    receipt = read(PREV/'native-harness-v2.json')
    assert receipt['collected']==1 and receipt['status']=='collected'
    assert digest(receipt['executable'])==receipt['binarySha256']
    assert digest(receipt['executable']+'.manifest')==receipt['manifestSha256']
    assert read(PREV/'soak-result.json')['passed'] is False
    REPORT.mkdir(); DEST.mkdir()
    save(REPORT/'contract.json', {
        'at':now(), 'driverSha256':digest(__file__), 'budgetSeconds':300,
        'operations':'12 fixed revisions 777000..777011 on ids000..003 modulo4, each followed by identical retry; delete/recreate060 after revisions5 and11;28 total; one final clean restart.',
        'readOrder':'ACK, completion, target query, full EvidenceReader state+all chunks, prior-token and opposite-project queries. Extra negative checks separately timed.',
        'correctness':'Every authoritative note and vector chunk equals expected current content; deleted id absent from both searches/state; correct project; stop on mismatch. Old-token hit is diagnostic candidate signal, not proof of stale text use.',
        'historicalTrend':'All663cycles, 60cycle nonoverlapping windows; last incomplete window reported but excluded from trend rule. Separate first writes/retries/deletes/recreates. Alert if last3complete window medians each exceed first3window median by both20% and250ms, or last3window P95 each exceed baseline P95 by both30% and500ms. Report endpoint spikes independently. Predeclared diagnostic heuristic, not an acceptance gate or proof of absence.',
        'thresholds':'Retain5s postACK complete audit and10s restart as diagnostic flags only; no regrading of original or future qualification. Query-first costs not comparable to original state-first totals.',
        'limits':'Serial RPC cannot test concurrent reading betweenACK and index commit. Searches return ids only; validate content via real EvidenceReader plus vectors. Not actual model injection, production memory integration or24h qualification.',
        'stop':'One run only, no retries of failed experiment, no compile/production edits/model calls/soak restart/backend decision. Keep original contracts and all failures. Retain evidence and isolated state.',
        'sourceManifest':manifest(SOURCE),
        'protected':{str(p):digest(p) for p in [PREV/'soak-result.json',PREV/'soak-contract.json',AREA/'soak-v3/cycles.jsonl',AREA/'soak-v3/phases.jsonl',*[ROOT/p for p in FILES]]}})
    save(REPORT/'native-harness-v2.json',receipt)
    print('Registered:28 operations,300s,one restart; original files protected.')

def history():
    cycles=[json.loads(s) for s in (AREA/'soak-v3/cycles.jsonl').read_text(encoding='utf-8').splitlines()]
    def metric(c):
        return {'ackMs':c['receipt']['ackMs'], 'indexMs':c['timing']['completionWaitMs'],
                'auditReadMs':c['timing']['stateReadMs'], 'queryMs':c['timing']['queryMs'],
                'postAckFullMs':c['queryAfterAckMs']}
    first=[metric(c['checks'][0]) for c in cycles]
    windows=[]
    for i in range(0,len(cycles),60):
        sample=first[i:i+60]
        windows.append({'startCycle':i,'n':len(sample),'metrics':{k:stats([r[k] for r in sample]) for k in sample[0]}})
    full=[w for w in windows if w['n']==60]; alerts={}
    for k in first[0]:
        base=stats([r[k] for r in first[:180]])
        alerts[k]={'baseline':base,
            'sustainedMedianAlert':all(w['metrics'][k]['median']>max(base['median']*1.2,base['median']+250) for w in full[-3:]),
            'sustainedP95Alert':all(w['metrics'][k]['p95']>max(base['p95']*1.3,base['p95']+500) for w in full[-3:])}
    checks=[x for c in cycles for x in c['checks']]
    groups={'write':[c['checks'][0] for c in cycles],'retry':[c['checks'][1] for c in cycles],
            'delete':[c['checks'][2] for c in cycles if len(c['checks'])==4],
            'recreate':[c['checks'][3] for c in cycles if len(c['checks'])==4]}
    out={'cycles':len(cycles),'checks':len(checks),'originalFailed':sum(not c['passed'] for c in checks),
         'stateMismatches':sum(not c['ready']['ready'] for c in checks),
         'queryOrDeletionFailures':sum(not c.get('queryFound',c.get('absent',False)) for c in checks),
         'scopeFailures':sum(not c['scopePassed'] for c in cycles),'windows':windows,'trend':alerts,
         'groups':{g:{k:stats([metric(c)[k] for c in rows]) for k in first[0]} for g,rows in groups.items()},
         'slowest':sorted([{'operationId':c['operationId'],**metric(c)} for c in checks],key=lambda x:x['postAckFullMs'],reverse=True)[:5]}
    save(REPORT/'history.json',out)

def run():
    contract=read(REPORT/'contract.json'); assert digest(__file__)==contract['driverSha256']
    assert not (DEST/'run.started').exists()
    save(DEST/'run.started',{'at':now(),'pid':os.getpid(),'createTime':psutil.Process().create_time()})
    history(); assert contract['sourceManifest']==manifest(SOURCE)
    began=time.perf_counter(); shutil.copytree(SOURCE,DEST/'state'); copy_ms=(time.perf_counter()-began)*1000
    native.REPORTS=REPORT
    expected={r['id']:r['content'] for r in corpus()}; versions={n:0 for n in range(100)}
    for cycle in range(663):
        n=cycle%20; expected[f'hbm-op-{n:03}']=body(n,cycle+1); versions[n]=cycle+1
    result={'startedAt':now(),'rows':[],'copyMs':copy_ms,'owned':[]}; client=None
    start_time=time.perf_counter(); deadline=start_time+300
    old_receive=native.Native.receive
    def receive(self):
        remaining=deadline-time.perf_counter()
        if remaining<=0:raise TimeoutError('300s fixed budget exhausted')
        r=self.queue.get(timeout=min(remaining,180))
        if isinstance(r,Exception):raise r
        if r is None:raise RuntimeError('RPC exited')
        return r
    native.Native.receive=receive
    def checked(n,revision,delete=False,retry=False):
        mid=f'hbm-op-{n:03}'; content=body(n,revision); old_version=versions[n]
        ack=client.delete(mid) if delete else client.write(mid,content)
        if delete:expected.pop(mid,None)
        else:expected[mid]=content
        done=client.receive(); assert done['ok'];client.pending=False
        index_ms=(time.perf_counter()-client.last_ack)*1000
        found=lookup(client,mid,content,absent=delete,revision=revision)
        query_at=(time.perf_counter()-client.last_ack)*1000
        snap=client.snapshot(); valid=matches(snap,expected)
        audit_at=(time.perf_counter()-client.last_ack)*1000
        prior=client.search(content[:230],lexical=f'HBMOP{n:03}S00V{old_version}') if not delete and old_version!=revision else None
        opposite=client.search(content[:230],project='right',lexical=f'HBMOP{n:03}S00V{revision}')
        scope=mid not in opposite['vectorIds']+opposite['lexicalIds']
        row={'id':mid,'revision':revision,'priorRevision':old_version,'delete':delete,'retry':retry,
             'ack':ack,'indexMs':index_ms,'queryAfterAckMs':query_at,'auditAfterAckMs':audit_at,
             'wholeStateMatches':valid,'queryOrAbsent':found,'scopePassed':scope,
             'oldTokenCandidate':mid in prior['lexicalIds'] if prior is not None else None,
             'negativeCheckMs':(time.perf_counter()-client.last_ack)*1000-audit_at,
             'auditWithinOriginal5s':valid and found and audit_at<=5000,
             'targetBodySha256':hashlib.sha256(snap['notes'][mid].encode()).hexdigest() if mid in snap['notes'] else None,
             'usage':client.usage()}
        if not delete:versions[n]=revision
        result['rows'].append(row);save(REPORT/f'step-{len(result["rows"]):02}.json',row)
        assert valid and found and scope,'Substantive correctness failed; stop'
    try:
        client=start(DEST/'state');result['owned']+=client.usage()['members'];assert matches(client.snapshot(),expected)
        for i in range(12):
            for retry in [False,True]:checked(i%4,777000+i,retry=retry)
            if i in [5,11]:checked(60,0,delete=True);checked(60,0)
        assert not client.close();client=None
        t=time.perf_counter();client=start(DEST/'state');result['owned']+=client.usage()['members']
        found=lookup(client,'hbm-op-003',expected['hbm-op-003'],revision=777011)
        result['restartFirstQueryMs']=(time.perf_counter()-t)*1000
        result['restartStateMatches']=matches(client.snapshot(),expected)
        assert found and result['restartStateMatches']
        result['status']='completed'
    except BaseException as e:result.update(status='failed',error=repr(e))
    finally:
        native.Native.receive=old_receive
        result['residualBeforeCleanup']=client.close() if client else []
        result['wallMs']=(time.perf_counter()-start_time)*1000
        result['sourceUnchanged']=contract['sourceManifest']==manifest(SOURCE)
        result['protectedUnchanged']=all(digest(p)==h for p,h in contract['protected'].items())
        residual=[]
        for m in result['owned']:
            try:
                if abs(psutil.Process(m['pid']).create_time()-m['createTime'])<.01:residual.append(m)
            except psutil.NoSuchProcess:pass
        result['residual']=residual;result['finishedAt']=now();save(REPORT/'result.json',result)
    print(json.dumps({k:result.get(k) for k in ['status','error','wallMs','sourceUnchanged','protectedUnchanged','residual']}))

if __name__=='__main__':{'register':register,'run':run}[sys.argv[1]]()
