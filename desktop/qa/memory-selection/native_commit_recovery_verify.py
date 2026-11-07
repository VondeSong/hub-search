"""Verify production recovery against an untouched copy of the real failure."""
from native_soak_failure_probe import *

VERIFY=ROOT/'artifacts/hbm-00-native-commit-recovery-20261019'
STATE=AREA/'commit-recovery-20261019'
SOURCES=['src-tauri/src/search_index.rs','src-tauri/src/search_index_runtime.rs','src-tauri/src/search_index_runtime_tests.rs']

def freeze():
    VERIFY.mkdir(exist_ok=False)
    save(VERIFY/'contract.json',{'at':now(),'scope':'One production recovery change;7 exact index owner tests plus one real failed-state copy with10replays/delete/recreate/restart. No24h restart, quality evaluation or backend selection.',
      'sources':{p:digest(ROOT/p) for p in SOURCES},'driverSha256':digest(__file__),'previousFailedResultSha256':digest(OUT/'soak-result.json'),
      'oldBinarySha256':read(OUT/'native-harness-v2.json')['binarySha256'],'thresholds':{'startupMs':10000,'postAckMs':5000},
      'budget':'One compiled revision, seven index-owner tests, one copy probe<=180s; build wrappers may reuse the same build to collect exact RPC. Compile failures retained.',
      'limitations':'No OS file-operation trace for original AccessDenied; diagnostic adds commit phase,index directory,upstream Debug error, not an invented filename.'})

def run():
    method=read(VERIFY/'contract.json')
    amendment=read(VERIFY/'method-amendment.json')
    assert digest(VERIFY/'contract.json')==amendment['originalContractSha256']
    assert all(digest(ROOT/p)==h for p,h in amendment['sources'].items())
    save(VERIFY/'executed-driver.json',{'at':now(),'sha256':digest(__file__),'amendmentSha256':digest(VERIFY/'method-amendment.json')})
    receipt=native.collect_receipt();assert receipt['binarySha256']!=method['oldBinarySha256']
    save(VERIFY/'native-harness-v2.json',receipt);native.REPORTS=VERIFY
    source=AREA/'soak/state';before=read(REPORT/'source-manifest.json')
    assert before=={str(p.relative_to(source)):digest(p) for p in source.rglob('*') if p.is_file()}
    shutil.copytree(source,STATE)
    expected={r['id']:r['content'] for r in corpus()}
    for cycle in range(61):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    client=None;result={'at':now(),'checks':[]};began=time.perf_counter()
    try:
        client=start(STATE)
        result['firstQueryFound']=lookup(client,'hbm-op-000',expected['hbm-op-000'],revision=61)
        result['startupMs']=(time.perf_counter()-began)*1000
        result['wholeStateMatches']=matches(client.snapshot(),expected)
        for n in range(10):
            assert time.perf_counter()-began<180
            row=write_checked(client,'hbm-op-000',expected['hbm-op-000'],expected,61)
            result['checks'].append(row);print(json.dumps({'replay':n,'passed':row['passed']}),flush=True)
            if not row['passed']:break
        result['checks'].append(delete_checked(client,'hbm-op-060',expected))
        result['checks'].append(write_checked(client,'hbm-op-060',body(60),expected))
        assert not client.close();client=None
        second=time.perf_counter();client=start(STATE)
        result['restartFound']=lookup(client,'hbm-op-000',expected['hbm-op-000'],revision=61)
        result['restartMs']=(time.perf_counter()-second)*1000
        result['restartWholeStateMatches']=matches(client.snapshot(),expected)
        result['passed']=result['firstQueryFound'] and result['wholeStateMatches'] and result['startupMs']<=10000 and result['restartFound'] and result['restartMs']<=10000 and result['restartWholeStateMatches'] and len(result['checks'])==12 and all(x['passed'] for x in result['checks'])
        result['status']='completed'
    except BaseException as e:result.update(status='failed',passed=False,error=str(e))
    finally:
        result['residual']=client.close() if client else []
        result['originalUnchanged']=before=={str(p.relative_to(source)):digest(p) for p in source.rglob('*') if p.is_file()}
        with sqlite3.connect((STATE/'craft-search.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as c:
            result['generations']=c.execute('SELECT id,status,last_error FROM search_index_generations').fetchall()
        result['recoveryCount']=sum(bool(x[2] and x[2].startswith('commit-recovery-attempted:')) for x in result['generations'])
        if result['residual'] or not result['originalUnchanged'] or result['recoveryCount']!=1:result['passed']=False
        result['wallMs']=(time.perf_counter()-began)*1000;save(VERIFY/'result.json',result)
    print(json.dumps({k:result.get(k) for k in ['status','passed','startupMs','restartMs','originalUnchanged','recoveryCount','residual']}),flush=True)

if __name__=='__main__':
    import sys
    freeze() if sys.argv[1]=='freeze' else run()
