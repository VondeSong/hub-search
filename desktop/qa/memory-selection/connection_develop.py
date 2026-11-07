"""Bounded same-process crossover: independent threads vs native history reset.

The reset candidate failed actual remote reuse in preflight. Retain the negative
experiment and measure its timing; never rename it as connection reuse.
"""
from datetime import datetime,timezone
import json
from pathlib import Path
import statistics
import time

from applicability_policy import POLICY,SCHEMA,validate_decisions
from connection_support import ROOT,WORK,PREVIOUS,MODEL,EFFORT,save,read,digest
from connection_transport import ReusableSession,secret_scan

ACTORS=['connection_support.py','connection_transport.py','connection_develop.py',
        'latency_transport.py','latency_reuse.py','applicability_policy.py','passage_model.py']

def sources():
    return {name:digest(Path(__file__).with_name(name)) for name in ACTORS}

def stats(values):
    return {'n':len(values),'medianMs':statistics.median(values),
            'p95Ms':statistics.quantiles(values,n=100,method='inclusive')[94],
            'minMs':min(values),'maxMs':max(values)}

if __name__=='__main__':
    questions=read_previous=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    evaluation=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))['results']
    slow_ids=[r['id'] for r in sorted(evaluation,key=lambda r:-r['endToEndMs'])[:3]]
    selected=[next(q for q in questions if q['id']==ident) for ident in slow_ids]
    selected+=sorted([q for q in questions if q['id'] not in slow_ids],key=lambda q:q['id'])[:9]
    inputs={q['id']:ROOT/f'.local/hbm-00/latency-20261018/validation-{questions.index(q)+1:03}/input.txt' for q in selected}
    save('development-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),
        'cases':[q['id'] for q in selected],'slowPriorIds':slow_ids,
        'inputs':{ident:digest(path) for ident,path in inputs.items()},'actorSources':sources(),
        'modes':['persistent','reset'],'rounds':2,'turnsMax':48,
        'order':'AB/BA alternate by case, reversed in round 2; reset first on first pair so owned paginated thread is materialized.',
        'sameProcessHomeCwd':True,'explicitRetries':0,'model':MODEL,'effort':EFFORT,
        'candidatePreflight':'Native revert empties history but reconnects. Public independent-response WebSocket handshake returns 401; no private-endpoint or paid-key fallback.',
        'eligibility':'Original scope gates unchanged. Reset cannot be selected without observed cross-question remote reuse even if quicker.',
        'observation':'Both modes use the same local allowlisted OTel collector. Native logs remain experiment-owned. No socket enumeration or TLS interception.',
        'limitations':'24 paired observations of 12 disclosed questions, same account, cache and remote workload uncontrolled; no new holdout exists yet.'})
    session=None
    rows=[]
    status='starting'
    began=time.perf_counter()
    try:
        session=ReusableSession('development-server',telemetry=True)
        for round_no in [1,2]:
            for index,q in enumerate(selected):
                prompt=inputs[q['id']].read_text(encoding='utf-8')
                payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
                assert set(payload)=={'project','memories','tasks'}
                order=['reset','persistent'] if (index+round_no)%2 else ['persistent','reset']
                for mode in order:
                    name=f'development-r{round_no}-{index+1:02}-{mode}'
                    start=time.time_ns()
                    response,receipt=(session.call(prompt,SCHEMA,WORK/name) if mode=='reset'
                                      else session.wire.app_call(prompt,SCHEMA,WORK/name))
                    stop=time.time_ns()
                    checked=validate_decisions(response,payload['tasks'],payload['memories'])[0]
                    row={'id':q['id'],'round':round_no,'caseNumber':index+1,'mode':mode,'directory':name,
                         'startUnixNs':start,'endUnixNs':stop,'callMs':receipt['durationMs'],
                         'checked':checked,'correct':not checked['invalid'] and set(checked['ids'])==set(q['expected']),
                         'receipt':receipt,'promptSha256':receipt['inputSha256']}
                    assert row['promptSha256']==digest(inputs[q['id']])
                    save(name+'.json',row)
                    rows.append(row)
                    print(json.dumps({'completed':len(rows),'total':48,'round':round_no,'case':index+1,
                                      'mode':mode,'callMs':round(row['callMs'],2)}),flush=True)
        status='completed'
    finally:
        if session:
            session.close()
        events=[e for e in session.wire.telemetry.rows if e.get('event.name') in ['codex.websocket_connect','codex.websocket_request']] if session else []
        for row in rows:
            row['remoteEvents']=[e for e in events if row['startUnixNs']<=int(e.get('timeUnixNano') or 0)<=row['endUnixNs']]
        save('development-raw.json',{'status':status,'results':rows,'events':events,
             'totalMs':(time.perf_counter()-began)*1000,
             'initializeMs':session.wire.initialize_ms if session else None})
    by_mode={mode:[r for r in rows if r['mode']==mode] for mode in ['persistent','reset']}
    base={(r['round'],r['id']):r['callMs'] for r in by_mode['persistent']}
    savings=[1-r['callMs']/base[(r['round'],r['id'])] for r in by_mode['reset']]
    connections={mode:sum(e.get('event.name')=='codex.websocket_connect' for r in rr for e in r['remoteEvents']) for mode,rr in by_mode.items()}
    timings={mode:stats([r['callMs'] for r in rr]) for mode,rr in by_mode.items()}
    no_cross_question_reuse=connections['reset']==len(by_mode['reset'])
    eligibility=len(rows)==48 and all(r['correct'] for r in rows) and not no_cross_question_reuse
    qualifies=eligibility and statistics.median(savings)>=.1 and sum(v>0 for v in savings)>=16 and timings['reset']['p95Ms']<=timings['persistent']['p95Ms']
    assert sources()==read('development-contract.json')['actorSources']
    scan=secret_scan()
    assert not scan['credentialPersisted'] and not scan['authFileCopied']
    save('development.json',{'status':status,'observations':len(rows),'results':rows,'timing':timings,
        'nativeConnectCounts':connections,'samePid':len({r['receipt']['pid'] for r in rows})==1,
        'exactOutcomes':sum(r['correct'] for r in rows),'pairedMedianSaving':statistics.median(savings),
        'fasterPairs':sum(v>0 for v in savings),'candidateEligible':eligibility,
        'actualCrossQuestionRemoteReuse':False if no_cross_question_reuse else 'needs-audit',
        'candidateImprovementDemonstrated':qualifies,'chosen':'reset' if qualifies else 'persistent',
        'secretScan':scan,'limits':'Observed boundaries mix remote network, queue, prefill and hidden inference. No causal pure-inference claim. Reset API overhead included.'})
    print(json.dumps({'status':status,'observations':len(rows),'timing':timings,'connections':connections,
                      'correct':sum(r['correct'] for r in rows),'chosen':'reset' if qualifies else 'persistent'}))
