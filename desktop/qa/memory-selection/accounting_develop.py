"""One prospective whole-batch crossover; all requests/prewarms charged to owner."""
from datetime import datetime,timezone
import json
from pathlib import Path
import statistics
import time
from accounting_support import ROOT,WORK,REPORTS,save,read,digest
from accounting_transport import Wire,ResetSession,ledger,secret_scan
from accounting_tcp import Sampler
from applicability_policy import POLICY,SCHEMA,validate_decisions

ACTORS=['accounting_support.py','accounting_transport.py','accounting_tcp.py','accounting_develop.py',
        'connection_transport.py','latency_transport.py','latency_reuse.py','applicability_policy.py','passage_model.py']
def sources():
    return {name:digest(Path(__file__).with_name(name)) for name in ACTORS}
def stats(values):
    return {'n':len(values),'medianMs':statistics.median(values),
            'p95Ms':statistics.quantiles(values,n=100,method='inclusive')[94],
            'maxMs':max(values)}

if __name__=='__main__':
    prior=ROOT/'artifacts/hbm-00-latency-20261018'
    questions=json.loads((prior/'validation.json').read_text(encoding='utf-8'))['cases']
    old=json.loads((prior/'evaluation.json').read_text(encoding='utf-8'))['results']
    slow=[r['id'] for r in sorted(old,key=lambda r:-r['endToEndMs'])[:3]]
    selected=[next(q for q in questions if q['id']==ident) for ident in slow]
    selected.append(sorted([q for q in questions if not q['expected'] and q['id'] not in slow],key=lambda q:q['id'])[0])
    paths={q['id']:ROOT/f'.local/hbm-00/latency-20261018/validation-{questions.index(q)+1:03}/input.txt' for q in selected}
    modes=['persistent-ws','reset-ws','reset-http']
    save('development-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),'N':4,'rounds':2,'gapSeconds':[0,5],
        'cases':[q['id'] for q in selected],'inputs':{q['id']:digest(paths[q['id']]) for q in selected},
        'modes':modes,'sources':sources(),'callsMax':48,'criterion':read('scope-contract.json')['selection'],
        'httpCandidate':'Native HTTP with paginated thread/revert; fresh-thread and reset HTTP preflights both correct, with no WS prewarm. Neither preflight establishes remote connection reuse; TCP samples are only proxy-leg observations.',
        'reuseQualification':'WS candidate requires fewer connect events than questions, all requests on successful existing authenticated connections, no retained history. HTTP candidate requires unambiguous native pool reuse correlated to independent turns; keep-alive headers or local proxy socket persistence alone do not pass.',
        'order':'Round 1 mode rotation by cadence; round 2 reverses each cadence order. Entire N-question batch per isolated process, shared cwd and state root.'})
    batches=[]; all_questions=[]; status='starting'
    try:
        for round_no in [1,2]:
            for cadence_index,gap in enumerate([0,5]):
                order=modes[cadence_index:]+modes[:cadence_index]
                if round_no==2:
                    order=list(reversed(order))
                for mode in order:
                    name=f'development-r{round_no}-gap{gap}-{mode}'
                    began=time.perf_counter(); start_ns=time.time_ns(); session=wire=sampler=None
                    batch_questions=[]; gaps=[]; settled=None
                    try:
                        if mode.startswith('reset'):
                            session=ResetSession(name,http=mode=='reset-http'); wire=session.wire
                        else:
                            wire=Wire(WORK/name,http=False)
                        sampler=Sampler(wire.process.pid)
                        for number,q in enumerate(selected,1):
                            if number>1 and gap:
                                idle=time.perf_counter(); time.sleep(gap); gaps.append((time.perf_counter()-idle)*1000)
                            prompt=paths[q['id']].read_text(encoding='utf-8')
                            payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
                            qs=time.time_ns()
                            response,receipt=(session.call(prompt,SCHEMA,WORK/f'{name}-q{number}') if session else wire.app_call(prompt,SCHEMA,WORK/f'{name}-q{number}'))
                            qe=time.time_ns()
                            checked=validate_decisions(response,payload['tasks'],payload['memories'])[0]
                            assert not checked['invalid'] and set(checked['ids'])==set(q['expected'])
                            assert receipt['inputSha256']==digest(paths[q['id']])
                            row={'id':q['id'],'number':number,'mode':mode,'round':round_no,'gapSeconds':gap,
                                 'startUnixNs':qs,'endUnixNs':qe,'receipt':receipt,'checked':checked}
                            batch_questions.append(row); all_questions.append(row)
                            print(json.dumps({'completedTurns':len(all_questions),'total':48,'batch':name,'question':number,
                                              'callMs':round(receipt['durationMs'],2)}),flush=True)
                        delivery_wall=(time.perf_counter()-began)*1000
                        settled=wire.drain(9 if mode=='reset-ws' else 8 if mode=='persistent-ws' else 4)
                    finally:
                        if session:
                            session.close()
                        elif wire:
                            wire.close()
                        observed=sampler.close() if sampler else None
                    elapsed=(time.perf_counter()-began)*1000
                    counted=ledger(wire.telemetry.rows,batch_questions)
                    assert all(r['requestToCompletionMs'] is not None for r in counted['requests'])
                    batch={'name':name,'mode':mode,'round':round_no,'gapSeconds':gap,'N':4,
                        'startUnixNs':start_ns,'endUnixNs':time.time_ns(),'questions':batch_questions,
                        'wholeBatchWallMs':elapsed,'actualUserGapsMs':sum(gaps),'scheduledUserGapsMs':gap*3*1000,
                        'activeWallMs':elapsed-sum(gaps),'deliveryWallMs':delivery_wall,
                        'deliveryActiveWallMs':delivery_wall-sum(gaps),'postDeliveryMs':elapsed-delivery_wall,
                        'drain':settled,'ledger':counted,'tcpObservation':observed}
                    save(name+'.json',batch); batches.append(batch)
                    print(json.dumps({'completedBatches':len(batches),'batch':name,'wallMs':elapsed,
                                      'processedTokens':counted['totalTokens'],'prewarms':counted['prewarmRequests']}),flush=True)
        status='completed'
    finally:
        save('development-raw.json',{'status':status,'batches':batches,'questions':all_questions,'sources':sources()})
    assert read('development-contract.json')['sources']==sources()
    comparison={}
    for mode in ['reset-ws','reset-http']:
        by_cadence={}
        for gap in [0,5]:
            rr=[b for b in batches if b['mode']==mode and b['gapSeconds']==gap]
            bb=[next(b for b in batches if b['mode']=='persistent-ws' and b['round']==r['round'] and b['gapSeconds']==gap) for r in rr]
            saving=[1-r['activeWallMs']/b['activeWallMs'] for r,b in zip(rr,bb)]
            token_saving=[1-r['ledger']['totalTokens']/b['ledger']['totalTokens'] for r,b in zip(rr,bb)]
            q_times=[q['receipt']['durationMs'] for b in rr for q in b['questions']]
            b_times=[q['receipt']['durationMs'] for b in bb for q in b['questions']]
            by_cadence[str(gap)]={'medianPairedActiveWallSaving':statistics.median(saving),
                'medianPairedTokenSaving':statistics.median(token_saving),'candidateLatency':stats(q_times),
                'baselineLatency':stats(b_times),'numericGate':statistics.median(saving)>=.1 and statistics.median(token_saving)>=.1 and stats(q_times)['p95Ms']<=stats(b_times)['p95Ms']}
        # Native reset WS reconnects; HTTP pool-only trace was not emitted and
        # proxy-leg socket observations are insufficient. Do not promote a
        # cheaper transport as proven connection reuse without that evidence.
        comparison[mode]={'cadences':by_cadence,'observedRemoteReuse':False,'eligible':False,
            'reason':'No qualifying independent-question remote connection reuse evidence; full-cost numerical savings alone cannot pass.'}
    scan=secret_scan(); assert not scan['credentialPersisted'] and not scan['authFileCopied']
    save('development.json',{'status':'completed','batches':len(batches),'turns':len(all_questions),
        'comparison':comparison,'chosen':'persistent-ws','eligibleReuseCandidate':False,
        'credentialScan':scan,'selectionRuleChanged':False,
        'limits':'Two batches per cadence per mode. Small disclosed crossover, variable cache and upstream load; not a stable causal speed estimate. HTTP no-prewarm is measured, but unproven pool reuse cannot qualify.'})
    print(json.dumps({'status':status,'batches':len(batches),'turns':len(all_questions),'chosen':'persistent-ws','comparison':comparison}))
