"""Identical lifecycle obligations; actual per-backend boundaries and costs."""
import argparse
from lifecycle_support import *
from lifecycle_bm import BM,body,corpus,prepare,config,rebind,matches,observe
from lifecycle_native import Native,collect_receipt

def freeze():
    preflight=read(REPORTS/'preflight-v2-result.json')
    assert preflight.get('nativeResidual')==[] and preflight.get('readback') and preflight.get('delete')
    assert read(REPORTS/'bm-identity-canary-result.json')['status']=='completed'
    profile=read(REPORTS/'bm-profile-v2.json')
    candidate=next(a for a in profile['arms'] if a['batch']==32)
    assert len(candidate['updates'])==4 and all(r['visibility']['ready'] for r in candidate['updates'])
    # No parameter search: one supported batch configuration specified before profiling.
    if not (REPORTS/'native-harness-v2.json').exists():save(REPORTS/'native-harness-v2.json',collect_receipt())
    assert read(REPORTS/'native-harness-v2.json')['binarySha256']==collect_receipt()['binarySha256']
    names=['lifecycle_support.py','lifecycle_bm.py','lifecycle_native.py','lifecycle_formal.py']
    save(REPORTS/'formal-method.json',{'at':now(),'sources':{n:digest(Path(__file__).with_name(n)) for n in names},
       'rustSha256':digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs'),
       'scopeSha256':digest(REPORTS/'scope.json'),'corpusSha256':digest(OLD_REPORTS/'backend-operational-corpus.json'),
       'batch':32,'order':['bm','native'],'coldRuns':5,'updateIds':list(range(20)),
       'deleteIds':list(range(20,40)),'replaceIds':list(range(40,60)),
       'visibility':'<=5000ms from actual receipt; diagnostic waiting<=60s never changes pass threshold',
       'retry':'Same complete write and already-absent delete, verify persistent state; no hidden retries of failed RPCs',
       'restore':'Close all owned producers; copy all state to backup and independent restored root; rebind BM projects only; original seed retained; confirm body/chunks/hashes and absent IDs through queries',
       'sameConditions':'Same whole notes, chunk texts, BGE weights/dimension/CPU threads, scopes, operations and limits. Provider implementation and ACK semantics explicitly reported. No native stored vectors copied from BM.',
       'observer':'BM checks original files plus text/vector index; native checks actual EvidenceReader plus same-transaction vector rows. Complete snapshot and comparison time included in readiness; file newline normalization only, no fact normalization.',
       'preflightRepairs':'Supported BM project move before copied-state startup; explicit stable permalink in write frontmatter; actual Hub reader bound20000characters with no truncation; exited-parent cleanup race handled. All prior failure reports kept.',
       'excluded':'Quality tuning, reranking, full production memory integration, abrupt crash injection,24h and backend selection'} )
    print('Formal lifecycle method frozen before either arm.')

def formal(kind):
    contract=read(REPORTS/'formal-method.json')
    assert all(digest(Path(__file__).with_name(n))==h for n,h in contract['sources'].items())
    assert digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs')==contract['rustSha256']
    state=WORK/f'{kind}-formal';factory=BM if kind=='bm' else Native
    result={'at':now(),'kind':kind,'status':'running','cold':[],'operations':[],'modelCalls':0,'productionMemoryIntegrated':False}
    expected={r['id']:r['content'] for r in corpus()};deleted=set();client=None;began=time.perf_counter()
    try:
        init=time.perf_counter()
        if kind=='bm':prepare(state,32)
        client=factory(state)
        if kind=='native':
            for r in corpus():client.write(r['id'],r['content'],r['project'])
        ready=observe(client,expected,timeout=1200);assert ready['ready']
        result['initialMs']=(time.perf_counter()-init)*1000
        result['initialCounts']={'notes':len(expected),'chunks':5100}
        result['initialResources']=client.usage();client.close();client=None
        for n in range(5):
            start=time.perf_counter();client=factory(state)
            hit=client.search(expected['hbm-op-000'][:230],lexical='HBMOP000S00V0')
            ms=(time.perf_counter()-start)*1000
            row={'firstUsableMs':ms,'within10s':ms<=10000,'sourceReturned':'hbm-op-000' in hit['vectorIds'] and 'hbm-op-000' in hit['lexicalIds'],'resources':client.usage()}
            result['cold'].append(row);assert row['sourceReturned']
            if n<4:client.close();client=None
        for operation,numbers in [('update',range(20)),('delete',range(20,40)),('replace',range(40,60))]:
            for number in numbers:
                mid=f'hbm-op-{number:03}';start=time.perf_counter()
                row={'kind':operation,'id':mid,'at':now(),'steps':[],'status':'running'};result['operations'].append(row)
                if operation=='update':
                    content=body(number,1);receipt=client.write(mid,content);expected[mid]=content
                    visibility=observe(client,expected,client.last_ack)
                    row['steps'].append({'operation':'write',**receipt,'visibility':visibility});assert visibility['ready']
                    row['readback']=client.readback(mid,content)
                    receipt=client.write(mid,content);visibility=observe(client,expected,client.last_ack)
                    row['steps'].append({'operation':'retryWrite',**receipt,'visibility':visibility});assert visibility['ready']
                    hits=client.search(content[:230],lexical=f'HBMOP{number:03}S00V1')
                    row['newVersionRetrieved']=mid in hits['vectorIds'] and mid in hits['lexicalIds']
                    old=client.search(body(number)[:230],lexical=f'HBMOP{number:03}S00V0')
                    row['oldTextInvisible']=mid not in old['lexicalIds']
                else:
                    if operation=='replace':
                        successor=f'hbm-op-{number+60:03}';content=body(number+60)
                        receipt=client.write(successor,content);expected[successor]=content
                        visibility=observe(client,expected,client.last_ack)
                        row['steps'].append({'operation':'successorWrite',**receipt,'visibility':visibility});assert visibility['ready']
                        row['readback']=client.readback(successor,content)
                    receipt=client.delete(mid);del expected[mid];deleted.add(mid)
                    visibility=observe(client,expected,client.last_ack)
                    row['steps'].append({'operation':'delete',**receipt,'visibility':visibility});assert visibility['ready']
                    receipt=client.delete(mid);visibility=observe(client,expected,client.last_ack)
                    row['steps'].append({'operation':'retryDelete',**receipt,'visibility':visibility});assert visibility['ready']
                    hits=client.search(body(number)[:230],lexical=f'HBMOP{number:03}S00V0')
                    row['deletedInvisible']=not deleted.intersection(hits['vectorIds']+hits['lexicalIds'])
                    if operation=='replace':
                        hits=client.search(content[:230],lexical=f'HBMOP{number+60:03}S00V0')
                        row['successorRetrieved']=successor in hits['vectorIds'] and successor in hits['lexicalIds']
                row.update(status='completed',fullIncludingRetryMs=(time.perf_counter()-start)*1000)
                row['passed']=all(s['visibility']['within5s'] for s in row['steps']) and all(row.get(k,True) for k in ['readback','newVersionRetrieved','oldTextInvisible','deletedInvisible','successorRetrieved'])
                # Progress is not a final receipt; every completed operation is retained.
                from run import save as progress_save
                progress_save(WORK/f'{kind}-progress.json',result)
        scoped=client.search(body(80)[:230],project='left',lexical='HBMOP080S00V0')
        result['scopePassed']=not set(f'hbm-op-{i:03}' for i in range(80,100)).intersection(scoped['vectorIds']+scoped['lexicalIds'])
        result['finalResources']=client.usage();client.close();client=None
        backup=WORK/f'{kind}-backup';shutil.copytree(state,backup)
        restored=WORK/f'{kind}-restored';shutil.copytree(backup,restored)
        if kind=='bm':
            config(restored,32);rebind(restored)
        client=factory(restored);ready=observe(client,expected,timeout=60);assert ready['ready']
        d=client.snapshot()
        if kind=='bm':assert all(Path(d['projectPaths'][p]).resolve()==(restored/'notes'/p).resolve() for p in ['left','right'])
        checks=[]
        for n in [0,19,60,79,80,99,100,119]:
            mid=f'hbm-op-{n:03}';p='right' if 80<=n<100 else 'left'
            checks.append(client.readback(mid,expected[mid],p))
            hits=client.search(expected[mid][:230],p,lexical=f'HBMOP{n:03}S00V{1 if n<20 else 0}')
            checks.append(mid in hits['vectorIds'] and mid in hits['lexicalIds'])
            checks.append(not deleted.intersection(hits['vectorIds']+hits['lexicalIds']))
        result['backupRestorePassed']=all(checks)
        result['restoredNotes']=len(d['notes']);result['restoredVectors']=d['vectors']
        result['expectedHashes']={k:hashlib.sha256(v.encode()).hexdigest() for k,v in expected.items()}
        result['status']='completed'
        result['allLifecycleGatesPassed']=len(result['operations'])==60 and all(r['passed'] for r in result['operations']) and all(r['within10s'] for r in result['cold']) and result['backupRestorePassed'] and result['scopePassed']
    except BaseException as e:result.update(status='failed',errorType=type(e).__name__,error=str(e)[:600]);raise
    finally:
        if client:result['residual']=client.close()
        result['wallMs']=(time.perf_counter()-began)*1000
        save(REPORTS/f'{kind}-formal-result.json',result)
    print(json.dumps({'kind':kind,'status':result['status'],'passed':result['allLifecycleGatesPassed'],'operations':len(result['operations']),'wallMs':result['wallMs']}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['freeze','bm','native']);a=p.parse_args()
    freeze() if a.phase=='freeze' else formal(a.phase)
