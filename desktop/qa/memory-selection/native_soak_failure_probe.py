"""Bounded recovery probe of a preserved failed soak, never a soak restart."""
from native_recovery import *

DEST=AREA/'failure-probe-20261019'
REPORT=ROOT/'artifacts/hbm-00-native-soak-diagnosis-20261019'

def main():
    REPORT.mkdir(exist_ok=False)
    source=AREA/'soak/state'
    save(REPORT/'contract.json',{'at':now(),'scope':'Read-only original; one closed copy restart and ten identical-content replays, no new24h or backend adoption',
      'driverSha256':digest(__file__),'binarySha256':read(OUT/'native-harness-v2.json')['binarySha256'],
      'restartMs':10000,'postAckMs':5000,'maxReplays':10,'budgetSeconds':180,'originalResultSha256':digest(OUT/'soak-result.json')})
    before={str(p.relative_to(source)):digest(p) for p in source.rglob('*') if p.is_file()}
    save(REPORT/'source-manifest.json',before)
    expected={r['id']:r['content'] for r in corpus()}
    for cycle in range(61):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    with sqlite3.connect((source/'craft-search.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as db:
        jobs=db.execute('SELECT source_id,status,attempts,updated_at,next_attempt_at,last_error FROM index_jobs WHERE status!=?',('completed',)).fetchall()
        vectors=db.execute('SELECT count(*) FROM hbm_vectors').fetchone()[0]
        integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
    save(REPORT/'original-state.json',{'jobs':jobs,'vectorCount':vectors,'integrity':integrity,'versionExpectation':'After completed cycles0..59 plus first write of cycle60, expected000=V61; verified below on copy'})
    shutil.copytree(source,DEST)
    client=None;result={'at':now(),'status':'running','checks':[]};began=time.perf_counter()
    try:
        client=start(DEST)
        result['firstQueryFound']=lookup(client,'hbm-op-000',expected['hbm-op-000'],revision=61)
        result['restartMs']=(time.perf_counter()-began)*1000
        result['wholeStateMatches']=matches(client.snapshot(),expected)
        for n in range(10):
            assert time.perf_counter()-began<180
            row=write_checked(client,'hbm-op-000',expected['hbm-op-000'],expected,61)
            result['checks'].append(row)
            print(json.dumps({'replay':n,'passed':row['passed'],'postAckMs':row['queryAfterAckMs']}),flush=True)
            if not row['passed']:break
        result.update(status='completed',passed=result['firstQueryFound'] and result['restartMs']<=10000 and result['wholeStateMatches'] and len(result['checks'])==10 and all(x['passed'] for x in result['checks']))
    except BaseException as e:result.update(status='failed',passed=False,errorType=type(e).__name__,error=str(e))
    finally:
        result['residual']=client.close() if client else []
        result['wallMs']=(time.perf_counter()-began)*1000
        result['originalUnchanged']=before=={str(p.relative_to(source)):digest(p) for p in source.rglob('*') if p.is_file()}
        if result['residual'] or not result['originalUnchanged']:result['passed']=False
        save(REPORT/'probe-result.json',result)
    print(json.dumps({k:result.get(k) for k in ['status','passed','restartMs','wholeStateMatches','originalUnchanged','residual']}),flush=True)

if __name__=='__main__':main()
