"""Bounded replay of the frozen 100-note update sequence; no quality tuning."""
from lifecycle_support import *
from lifecycle_bm import BM,prepare,observe,body,corpus,config,rebind
import sqlite3
import sqlite_vec
import pickle
import run as transport

AREA=ROOT/'.local/hbm-00/update-reliability-minimal-20261019'
OUT=ROOT/'artifacts/hbm-00-update-reliability-minimal-20261019'

def connect(path):
    c=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
    c.enable_load_extension(True);sqlite_vec.load(c);c.enable_load_extension(False)
    return c

def capture(state):
    start=time.perf_counter()
    with connect(state/'config/memory.db') as c:
        c.execute('BEGIN')
        c.row_factory=sqlite3.Row
        rows=[dict(r) for r in c.execute("SELECT v.rowid AS vector_id,v.embedding,v.source_hash AS vector_hash,c.*,e.permalink FROM search_vector_embeddings v LEFT JOIN search_vector_chunks c ON c.id=v.rowid LEFT JOIN entity e ON e.id=c.entity_id")]
        index=[dict(r) for r in c.execute('SELECT id,type,entity_id,project_id,permalink,content_snippet FROM search_index')]
        projects=dict(c.execute('SELECT name,id FROM project'))
    return {'vectors':rows,'index':index,'projects':projects,'captureMs':(time.perf_counter()-start)*1000}


def search(client,mid,content):
    base={'project':'left','search_all_projects':False,'entity_types':['entity'],'page_size':50,'output_format':'json'}
    start=time.perf_counter()
    v=client.client.call('search_notes',{**base,'query':content[:230],'search_type':'vector','min_similarity':0.0})
    vector_end=time.perf_counter()
    t=client.client.call('search_notes',{**base,'query':f'核对口令是HBMOP{int(mid[-3:]):03}S00V1','search_type':'text'})
    ids=[transport.hit_identity(h) for h in transport.results_from(v)]
    tids=[transport.hit_identity(h) for h in transport.results_from(t)]
    return {'vector':v,'lexical':t,'vectorIds':ids,'lexicalIds':tids,
       'rank':ids.index(mid)+1 if mid in ids else None,'vectorMs':(vector_end-start)*1000,
       'postAckQueryCompleteMs':(time.perf_counter()-client.last_ack)*1000}

def main():
    AREA.mkdir(exist_ok=False);OUT.mkdir(exist_ok=False)
    save(OUT/'contract.json',{'at':now(),'sourceSha256':digest(__file__),
      'route':'root-cause remediation; local isolated QA + existing implementation documents only',
      'scope':'One targeted 100note/5100chunk replay, updates0..19 in original order including identical retry. No deletes until diagnosis closes. No production/vendor mutation, new quality questions, backend adoption, crash or soak launch.',
      'gates':'Same<=5000ms after ACK; actual project-scoped new-version query completion included. Existing quality/material/local-latency gaps retained.',
      'observerAmendment':'Paired diagnostic control: first-arm disk snapshots add400-700ms before query and may mask race. This arm captures a read-only consistent SQL projection in memory, persists only after live query. One control only, no parameter changes. Restored original closed100V0 store from bm-formal, same entire corpus verified before five fresh starts.',
      'observation':'Five fresh starts as before. Original primary write/ready/readback/retry/ready order retained. Snapshot immediately before and after original query; raw MCP responses retained. Diagnostic snapshot time counted, no free waits. Before/after are adjacent evidence, not atomic with live query.',
      'discrimination':'Offline exact per-snapshot vector ranks and valid source-hash joins; global K500, project membership, per-project ranks, metadata readiness versus searchable vectors. No expansion of runtime candidate limit for scoring.',
      'budget':'One replay<=15min, one offline diagnosis<=10min; at most one supported generic repair and one corresponding20update replay<=15min. No repeated tuning. If unmet mark candidate failed and prioritize native verification.',
      'corpusSha256':digest(OLD_REPORTS/'backend-operational-corpus.json'),
      'priorResultSha256':digest(REPORTS/'bm-formal-v2-result.json'),
      'dependencies':{n:digest(Path(__file__).with_name(n)) for n in ['lifecycle_support.py','lifecycle_bm.py','qualification_bm_lifecycle.py','run.py']},
      'modelCalls':0,'runner':'managed Python; existing BM0.23.2 support config sync_batch32/provider_batch2/threads2 unchanged'})
    expected={r['id']:r['content'] for r in corpus()};client=None;began=time.perf_counter()
    result={'at':now(),'status':'running','cold':[],'updates':[]}
    try:
        state=AREA/'replay';shutil.copytree(WORK/'bm-formal',state);config(state,32);rebind(state);client=BM(state)
        assert observe(client,expected,timeout=1200)['ready']
        client.close();client=None
        for i in range(5):
            start=time.perf_counter();client=BM(state)
            hits=client.search(expected['hbm-op-000'][:230],lexical='核对口令是HBMOP000S00V0')
            result['cold'].append({'ms':(time.perf_counter()-start)*1000,'hits':hits})
            if i<4:client.close();client=None
        for n in range(20):
            mid=f'hbm-op-{n:03}';content=body(n,1);row={'id':mid,'at':now()};result['updates'].append(row)
            row['write']=client.write(mid,content);expected[mid]=content
            row['ready']=observe(client,expected,client.last_ack);assert row['ready']['ready']
            row['readback']=client.readback(mid,content)
            row['retry']=client.write(mid,content)
            row['retryReady']=observe(client,expected,client.last_ack);assert row['retryReady']['ready']
            before=capture(state);row['beforeCaptureMs']=before['captureMs']
            row['query']=search(client,mid,content)
            after=capture(state);row['afterCaptureMs']=after['captureMs']
            for label,captured in [('before',before),('after',after)]:
                with (AREA/f'{n:02}-{label}.pickle').open('xb') as f:pickle.dump(captured,f)
            old=client.search(body(n)[:230],lexical=f'核对口令是HBMOP{n:03}S00V0')
            row['oldTextInvisible']=mid not in old['lexicalIds']
            row['passed']=row['ready']['within5s'] and row['retryReady']['within5s'] and row['query']['postAckQueryCompleteMs']<=5000 and mid in row['query']['vectorIds'] and mid in row['query']['lexicalIds'] and row['oldTextInvisible'] and row['readback']
            save(OUT/f'update-{n:02}.json',row)
            print(json.dumps({'id':mid,'passed':row['passed'],'rank':row['query']['rank'],'queryAfterAckMs':row['query']['postAckQueryCompleteMs']}),flush=True)
        result['status']='completed'
    except BaseException as e:result.update(status='failed',errorType=type(e).__name__,error=str(e));raise
    finally:
        result['residual']=client.close() if client else []
        result['wallMs']=(time.perf_counter()-began)*1000
        save(OUT/'replay.json',result)

if __name__=='__main__':main()
