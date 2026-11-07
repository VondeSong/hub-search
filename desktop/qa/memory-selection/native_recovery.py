"""Real process termination at deterministic transaction/index boundaries."""
from lifecycle_support import *
from lifecycle_bm import corpus,body,chunks,observe,matches
import lifecycle_native as native
import psutil,sqlite3

AREA=WORK/'recovery-20261019'
OUT=ROOT/'artifacts/hbm-00-native-recovery-20261019'
native.REPORTS=OUT

def start(state):return native.Native(state)

def terminate(client):
    owned=client.usage()['members'];client.p.kill();client.p.wait(timeout=10)
    for m in owned:
        try:
            p=psutil.Process(m['pid'])
            if abs(p.create_time()-m['createTime'])<.01 and p.is_running():p.kill();p.wait(timeout=10)
        except psutil.NoSuchProcess:pass
    residual=client.close();assert not residual
    return {'owned':owned,'parentExitCode':client.p.returncode,'residual':residual,'graceful':False}

def lookup(client,mid,content,absent=False,revision=0):
    h=client.search(content[:230],lexical=f'核对口令是HBMOP{int(mid[-3:]):03}S00V{revision}')
    return (mid not in h['vectorIds']+h['lexicalIds']) if absent else (mid in h['vectorIds'] and mid in h['lexicalIds'])

def write_checked(client,mid,content,expected,revision=0):
    receipt=client.write(mid,content);expected[mid]=content
    ready=observe(client,expected,client.last_ack)
    found=lookup(client,mid,content,revision=revision)
    elapsed=(time.perf_counter()-client.last_ack)*1000
    return {'receipt':receipt,'ready':ready,'queryFound':found,'queryAfterAckMs':elapsed,'passed':ready['within5s'] and found and elapsed<=5000}

def delete_checked(client,mid,expected):
    receipt=client.delete(mid);expected.pop(mid,None)
    ready=observe(client,expected,client.last_ack);absent=lookup(client,mid,body(int(mid[-3:])),absent=True)
    elapsed=(time.perf_counter()-client.last_ack)*1000
    return {'receipt':receipt,'ready':ready,'absent':absent,'queryAfterAckMs':elapsed,'passed':ready['within5s'] and absent and elapsed<=5000}

def main():
    AREA.mkdir(exist_ok=False)
    receipt=native.collect_receipt();save(OUT/'native-harness-v2.json',receipt)
    save(OUT/'method.json',{'at':now(),'sourceSha256':digest(__file__),'rustSha256':digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs'),
       'contractSha256':digest(OUT/'contract.json'),'binarySha256':receipt['binarySha256'],'corpusSha256':digest(OLD_REPORTS/'backend-operational-corpus.json')})
    client=None;result={'at':now(),'status':'running','cases':[]};began=time.perf_counter()
    baseline={r['id']:r['content'] for r in corpus()}
    try:
        client=start(AREA/'seed')
        for n,r in enumerate(corpus()):
            client.write(r['id'],r['content'],r['project'])
            if (n+1)%20==0:print(json.dumps({'seedNotes':n+1}),flush=True)
        assert observe(client,baseline)['ready'];assert not client.close();client=None
        cases=[(op,phase) for op in ['update','delete'] for phase in ['before_commit','after_commit','after_ack']]+[('replacement','after_ack')]
        for i,(op,phase) in enumerate(cases):
            state=AREA/f'case-{i}-{op}-{phase}';shutil.copytree(AREA/'seed',state)
            expected=dict(baseline);client=start(state)
            mid='hbm-op-040' if op=='delete' else ('hbm-op-100' if op=='replacement' else 'hbm-op-000')
            content=body(int(mid[-3:]),1 if op=='update' else 0)
            request={'op':'delete' if op=='delete' else 'write','id':mid,'project':'left','crashAt':phase}
            if op!='delete':request.update(body=content,chunks=chunks(mid,content))
            event=client.call(request);ack=None
            if event['event']=='ack':ack=event;event=client.receive()
            assert event=={'event':'crash_gate','phase':phase}
            row={'id':i,'operation':op,'phase':phase,'ackObserved':ack is not None,'crash':terminate(client)};client=None
            result['cases'].append(row)
            if phase!='before_commit':
                if op=='delete':expected.pop(mid)
                else:expected[mid]=content
            restart=time.perf_counter();client=start(state)
            assert lookup(client,'hbm-op-060',body(60))
            row['firstUsableMs']=(time.perf_counter()-restart)*1000
            row['recoveredStateMatches']=matches(client.snapshot(),expected)
            row['targetMatches']=lookup(client,mid,expected.get(mid,body(int(mid[-3:]))),absent=mid not in expected,revision=1 if op=='update' and phase!='before_commit' else 0)
            with sqlite3.connect((state/'craft-search.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as db:
                row['integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
            checks=[]
            if op=='delete':
                checks=[delete_checked(client,mid,expected),delete_checked(client,mid,expected)]
            else:
                checks=[write_checked(client,mid,content,expected,1 if op=='update' else 0)]
                if op=='replacement':checks.extend([delete_checked(client,'hbm-op-040',expected),delete_checked(client,'hbm-op-040',expected)])
                else:checks.append(write_checked(client,mid,content,expected,1))
            row['replay']=checks
            row['passed']=row['firstUsableMs']<=10000 and row['recoveredStateMatches'] and row['targetMatches'] and row['integrity']=='ok' and all(c['passed'] for c in checks)
            row['closeResidual']=client.close();client=None;row['passed'] &= not row['closeResidual']
            save(OUT/f'case-{i}.json',row)
            print(json.dumps({'case':i,'operation':op,'phase':phase,'passed':row['passed'],'restartMs':row['firstUsableMs']}),flush=True)
        result['status']='completed';result['passed']=all(r['passed'] for r in result['cases'])
    except BaseException as e:result.update(status='failed',errorType=type(e).__name__,error=str(e));raise
    finally:
        result['residual']=client.close() if client else []
        result['wallMs']=(time.perf_counter()-began)*1000
        save(OUT/'result.json',result)

if __name__=='__main__':main()
