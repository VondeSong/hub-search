"""Independent arithmetic/status projection; never rewrites raw run outcomes."""
import statistics, math
from collections import Counter
import psutil
from lifecycle_support import *

def metrics(values):
    return {'n':len(values),'medianMs':statistics.median(values),'p95Ms':sorted(values)[math.ceil(.95*len(values))-1],'maxMs':max(values)} if values else {'n':0}
def main():
    method=read(REPORTS/'formal-method-v2.json')
    identities={n:digest(ROOT/'qa/memory-selection'/n)==h for n,h in method['sources'].items()}
    identities['rust']=digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs')==method['rustSha256']
    identities['corpus']=digest(OLD_REPORTS/'backend-operational-corpus.json')==method['corpusSha256']
    identities['oldFailure']=digest(OLD_REPORTS/'bm-lifecycle-result.json')==read(REPORTS/'scope.json')['priorFailureSha256']
    assert all(identities.values()),identities
    arms={}
    for kind in ['bm','native']:
        raw=read(REPORTS/f'{kind}-formal-v2-result.json');assert raw['status'] in ['completed','failed']
        grouped={}
        for operation in ['update','delete','replace']:
            rows=[r for r in raw['operations'] if r['kind']==operation]
            steps=[s for r in rows for s in r['steps']]
            grouped[operation]={'attempted':len(rows),'completed':sum(r['status']=='completed' for r in rows),
              'passed':sum(r.get('passed',False) for r in rows),'steps':len(steps),
              'postAck':metrics([s['visibility']['elapsedMs'] for s in steps]),
              'primaryPostAck':metrics([r['steps'][0]['visibility']['elapsedMs'] for r in rows if r['steps']]),
              'ack':metrics([s['ackMs'] for s in steps]),
              'fullIncludingRetry':metrics([r['fullIncludingRetryMs'] for r in rows if 'fullIncludingRetryMs' in r]),
              'failedIds':[r['id'] for r in rows if not r.get('passed',False)]}
        complete=raw['status']=='completed' and all(g['passed']==20 and g['completed']==20 for g in grouped.values())
        passed=complete and len(raw['cold'])==5 and all(r['within10s'] and r['sourceReturned'] for r in raw['cold']) and raw.get('scopePassed') and raw.get('backupRestorePassed') and not raw.get('residual')
        arms[kind]={'status':raw['status'],'rawReportSha256':digest(REPORTS/f'{kind}-formal-v2-result.json'),
          'cold':metrics([r['firstUsableMs'] for r in raw['cold']]),'operations':grouped,
          'initialIndexMs':raw.get('initialMs'),'wallMs':raw['wallMs'],'backupRestorePassed':raw.get('backupRestorePassed',False),
          'restoredNotes':raw.get('restoredNotes'),'restoredVectors':raw.get('restoredVectors'),
          'scopePassed':raw.get('scopePassed',False),'gatePassed':bool(passed),
          'finalSampledRssMiB':raw.get('finalResources',{}).get('rssMiB'),
          'error':raw.get('error'),'expectedHashes':raw.get('expectedHashes')}
        if raw['status']=='completed':assert bool(passed)==raw['allLifecycleGatesPassed']
    residual=[]
    expected_exe=read(REPORTS/'native-harness-v2.json')['executable']
    for p in psutil.process_iter(['pid','cmdline']):
        try:
            cmd=p.info['cmdline'] or []
            if (cmd and str(cmd[0]).lower()==expected_exe.lower()) or any('lifecycle_formal_v2.py' in a for a in cmd):residual.append(p.pid)
        except (psutil.NoSuchProcess,psutil.AccessDenied):pass
    # Known BM-owned PIDs are checked by creation identity, not by process name.
    for state in ['bm-formal-v2','bm-restored-v2']:
        p=WORK/state/'process.json'
        if not p.exists():continue
        for m in read(p).get('owned',[]):
            try:
                q=psutil.Process(m['pid'])
                if abs(q.create_time()-m['createTime'])<.01:residual.append(q.pid)
            except psutil.NoSuchProcess:pass
    result={'at':now(),'identitiesUnchanged':identities,'arms':arms,'residualOwnedProcesses':sorted(set(residual)),
       'sameFinalContent':arms['bm']['expectedHashes'] is not None and arms['bm']['expectedHashes']==arms['native']['expectedHashes'],
       'backendSelected':False,'hbm00Complete':False,'laterBatchesStarted':False,
       'limitations':['Synthetic100note workload, not semantic quality or whole-vault capacity proof.',
        'Implementation audit found BM takes global vector top500 before project filtering, while native scopes before top500. Same workload and limits, not identical candidate generation; native code comment describing globalK is inaccurate. Retrieval counts cannot establish semantic parity or backend superiority.',
        'Native vector table and Rust cosine scan are test-only candidate implementation; actual Hub producers/readers and index jobs are used.',
        'ACK boundaries differ: native embeds before commit; BM schedules vector completion after receipt. Both ACK and post-ACK and total retry costs reported.',
        'Cold means new process with installed resources and existing index; OS cache not flushed; not application UI startup.',
        'All-step latency distributions include idempotent retries. Primary-step distributions are separate. RSS samples cover backend child trees, not the common Python QA controller or whole production application.',
        'No abrupt crash, secure erasure of history/backups/derived summaries, runtime upgrade rollback, real24h or distribution/license clearance.',
        'Old quality and performance gaps retained. No new remote LLM evaluation.']}
    save(REPORTS/'summary.json',result)
    print(json.dumps({k:{'passed':v['gatePassed'],'cold':v['cold'],'operations':{n:g['passed'] for n,g in v['operations'].items()},'restore':v['backupRestorePassed']} for k,v in arms.items()},ensure_ascii=False))
if __name__=='__main__':main()
