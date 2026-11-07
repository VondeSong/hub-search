"""Independent dynamic gate audit; same prospectively registered numerical rules."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import sqlite3
import statistics
from accounting_support import WORK,REPORTS,save,read,digest
from accounting_develop import stats

def register():
    save('selection-audit-contract.json',{'at':datetime.now(timezone.utc).isoformat(),
        'auditorSha256':digest(Path(__file__)),'developmentContractSha256':digest(REPORTS/'development-contract.json'),
        'role':'Recompute existing gates from raw whole-batch evidence; do not rely on provisional preflight-based eligibility in development.json.',
        'numericRuleUnchanged':True,
        'httpProof':'Only native network-pool trace indicating reuse, correlated to at least two distinct independent turns of the owned session. Local proxy socket overlap alone remains insufficient.'})

def audit():
    contract=read('selection-audit-contract.json')
    assert digest(Path(__file__))==contract['auditorSha256']
    raw=read('development-raw.json'); assert raw['status']=='completed' and len(raw['questions'])==48
    con=sqlite3.connect((WORK/'shared-codex-state/logs_2.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    pool=con.execute("SELECT ts,ts_nanos,thread_id,target,feedback_log_body FROM logs WHERE target LIKE 'hyper_util%pool%' OR target LIKE 'reqwest%pool%'").fetchall(); con.close()
    batches=raw['batches']; result={}; compact=[]
    for b in batches:
        ll=b['ledger']; compact.append({k:b[k] for k in ['name','mode','round','gapSeconds','N','wholeBatchWallMs','actualUserGapsMs','activeWallMs','deliveryActiveWallMs','postDeliveryMs']})
        compact[-1]['cost']={k:ll[k] for k in ['responseRequests','prewarmRequests','unusedFinalPrewarmRequests','allNetworkRequestCount','totalInputTokens','totalOutputTokens','cachedInputTokens','totalTokens','websocketConnects','usageComplete']}
        compact[-1]['sumResponseWaitMs']=sum(r['requestToCompletionMs'] for r in ll['requests'])
    for mode in ['reset-ws','reset-http']:
        cadences={}; reuse=[]
        for b in [b for b in batches if b['mode']==mode]:
            if mode=='reset-ws':
                proof=b['ledger']['websocketConnects']<b['N'] and b['ledger']['websocketConnects']>=1
                reason='Observed authenticated WS connect count across independent cleared-history turns.'
            else:
                turns=[q['receipt']['turnId'] for q in b['questions']]
                matched={turn for sec,ns,thread,target,body in pool
                         if b['startUnixNs']<=sec*1_000_000_000+ns<=b['endUnixNs'] and 'reuse' in (body or '').lower()
                         for turn in turns if turn in (body or '')}
                proof=len(matched)>=2; reason='Native per-turn pool reuse evidence available.' if proof else 'No qualifying native per-turn pool trace; proxy-leg sockets do not establish upstream reuse.'
            reuse.append({'batch':b['name'],'observed':proof,'reason':reason})
        for gap in [0,5]:
            rr=[b for b in batches if b['mode']==mode and b['gapSeconds']==gap]
            bb=[next(b for b in batches if b['mode']=='persistent-ws' and b['gapSeconds']==gap and b['round']==r['round']) for r in rr]
            wall=statistics.median(1-r['activeWallMs']/b['activeWallMs'] for r,b in zip(rr,bb))
            tokens=statistics.median(1-r['ledger']['totalTokens']/b['ledger']['totalTokens'] for r,b in zip(rr,bb))
            tt=stats([q['receipt']['durationMs'] for b in rr for q in b['questions']]); bt=stats([q['receipt']['durationMs'] for b in bb for q in b['questions']])
            cadences[str(gap)]={'medianPairedActiveWallSaving':wall,'medianPairedTokenSaving':tokens,
                'candidateLatency':tt,'baselineLatency':bt,'numericGate':wall>=.1 and tokens>=.1 and tt['p95Ms']<=bt['p95Ms']}
        result[mode]={'cadences':cadences,'reuseEvidence':reuse,'eligible':all(r['observed'] for r in reuse) and all(c['numericGate'] for c in cadences.values())}
    eligible=[m for m,r in result.items() if r['eligible']]
    chosen=min(eligible,key=lambda mode:statistics.median(b['activeWallMs'] for b in batches if b['mode']==mode)) if eligible else 'persistent-ws'
    save('development-audit.json',{'status':'completed','turns':48,'batches':compact,'comparison':result,'chosen':chosen,
        'observedRemoteReuseCandidate':bool(eligible),'allRequestUsageComplete':all(b['ledger']['usageComplete'] for b in batches),
        'nativePoolTraceEvents':len(pool),'selectionRuleChanged':False,'authoritativeRawSha256':digest(REPORTS/'development-raw.json'),
        'limits':'Two batches per cadence/mode, variable upstream load/cache. Total processed tokens are not paid dollars. Scheduled think time is removed only from user-active waiting, not request or token counts.'})
    print(json.dumps({'chosen':chosen,'comparison':result},ensure_ascii=True))
if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('phase',choices=['register','audit'])
    {'register':register,'audit':audit}[p.parse_args().phase]()
