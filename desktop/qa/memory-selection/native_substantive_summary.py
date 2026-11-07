"""Read-only analysis of one completed run, with a new non-overwriting receipt."""
from native_substantive_diagnosis import *

def main():
    r=read(REPORT/'result.json');h=read(REPORT/'history.json');c=read(REPORT/'contract.json')
    cycles=[json.loads(s) for s in (AREA/'soak-v3/cycles.jsonl').read_text(encoding='utf-8').splitlines()]
    groups={}
    for name,pos in [('write',0),('retry',1),('delete',2),('recreate',3)]:
        def metric(row,key):
            return row['receipt']['ackMs'] if key=='ackMs' else row['queryAfterAckMs'] if key=='postAckFullMs' else row['timing'][key]
        baseline=[v['checks'][pos] for v in cycles[:180] if len(v['checks'])>pos]
        windows=[[v['checks'][pos] for v in cycles[i:i+60] if len(v['checks'])>pos] for i in range(0,660,60)]
        checks={}
        for key in ['ackMs','completionWaitMs','stateReadMs','queryMs','postAckFullMs']:
            base=stats([metric(x,key) for x in baseline]);tail=[stats([metric(x,key) for x in w]) for w in windows[-3:]]
            checks[key]={'baseline':base,'lastThreeWindows':tail,
                'medianAlert':all(v['median']>max(base['median']*1.2,base['median']+250) for v in tail),
                'p95Alert':all(v['p95']>max(base['p95']*1.3,base['p95']+500) for v in tail)}
        groups[name]=checks
    residual=[]
    for m in r['owned']:
        try:
            if abs(psutil.Process(m['pid']).create_time()-m['createTime'])<.01:residual.append(m['pid'])
        except psutil.NoSuchProcess:pass
    out={'at':now(),'resultSha256':digest(REPORT/'result.json'),'contractSha256':digest(REPORT/'contract.json'),
         'status':r['status'],'operations':len(r['rows']),
         'correct':sum(x['wholeStateMatches'] and x['queryOrAbsent'] and x['scopePassed'] for x in r['rows']),
         'original5sDiagnosticFlagsPassed':sum(x['auditWithinOriginal5s'] for x in r['rows']),
         'timing':{k:stats([x[k] for x in r['rows']]) for k in ['indexMs','queryAfterAckMs','auditAfterAckMs','negativeCheckMs']},
         'ackMs':stats([x['ack']['ackMs'] for x in r['rows'] if not x['delete']]),
         'oldTokenChecks':sum(x['oldTokenCandidate'] is not None for x in r['rows']),
         'oldTokenCandidateHits':sum(x['oldTokenCandidate'] is True for x in r['rows']),
         'oldTokenInterpretation':'Candidate ID is not stale content: all full notes/chunks match latest expected; search code has fuzzy OR clauses. Per-hit branch was not traced. No actual model injection or concurrent in-flight read tested.',
         'historicalTrendAllOperationKinds':groups,
         'historicalTrendAlerts':sum(v['medianAlert'] or v['p95Alert'] for g in groups.values() for v in g.values()),
         'lateTailWarning':'Last incomplete3cycle window median4.837s; run ends there. No sustained earlier trend does not rule out newly developing degradation.',
         'restartFirstQueryMs':r['restartFirstQueryMs'],'restartStateMatches':r['restartStateMatches'],
         'copyMs':r['copyMs'],'runWallMs':r['wallMs'],'residual':residual,
         'protectedUnchanged':all(digest(p)==sha for p,sha in c['protected'].items()),
         'sourceUnchanged':manifest(SOURCE)==c['sourceManifest'],
         'oldSoakPassed':read(PREV/'soak-result.json')['passed'],
         'qualification':'No24h pass, no backend adoption, no new acceptance contract activated; stop bounded diagnosis.'}
    save(REPORT/'conclusion.json',out)
    print(json.dumps({k:v for k,v in out.items() if k!='historicalTrendAllOperationKinds'},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
