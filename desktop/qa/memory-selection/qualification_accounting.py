"""Close actual native requests, never assume that a prewarm was sent."""
from collections import Counter, defaultdict, deque
import time

from qualification_contract import *

def configure_transport():
    import accounting_support as support
    support.WORK, support.HOME, support.REPORTS = WORK, WORK/'codex-home', REPORTS
    import accounting_transport
    return accounting_transport

def reconcile(events, calls, native):
    pending = defaultdict(deque)
    signatures = set()
    sends = completed = 0
    for event in sorted(events, key=native.event_ns):
        name = event.get('event.name')
        if name=='codex.websocket_request':
            pending[event.get('conversation.id')].append(native.event_ns(event))
            sends += 1
        elif name=='codex.sse_event' and event.get('event.kind')=='response.completed' and 'input_token_count' in event:
            signature=(event.get('conversation.id'),native.event_ns(event))
            assert signature not in signatures, 'Duplicate usage completion'
            signatures.add(signature)
            queue=pending[event.get('conversation.id')]
            assert queue, 'Usage completion without a distinct prior observed send'
            sent=queue.pop()
            assert native.event_ns(event)>=sent, 'Completion precedes native send'
            completed += 1
    assert sends==completed and not any(pending.values()), 'Actual sent request is missing usage completion'
    ledger=native.ledger(events,calls)
    assert ledger['canonicalHttpResponseRequests']==0, 'Unregistered HTTP inference path'
    assert Counter(r['questionId'] for r in ledger['requests'] if r['role']=='question')==Counter(c['id'] for c in calls)
    assert len({(c['receipt']['threadId'],c['receipt']['turnId']) for c in calls})==len(calls)
    assert all(c['receipt']['status']=='completed' for c in calls)
    assert all(r['sentUnixNs'] is not None and r['requestToCompletionMs']>=0 for r in ledger['requests'])
    return ledger

def partial_ledger(events,calls,native):
    """Report actual unmatched sends and unknown costs without hiding scores.

    The matched subset is only for KNOWN usage arithmetic. Every unmatched send
    remains in the report and all-request count; usageComplete stays false.
    """
    rows=sorted(events,key=native.event_ns)
    pending=defaultdict(list);matched=set();unmatched_completions=[]
    for i,e in enumerate(rows):
        if e.get('event.name')=='codex.websocket_request':
            pending[e.get('conversation.id')].append(i)
        elif e.get('event.kind')=='response.completed' and 'input_token_count' in e:
            queue=pending[e.get('conversation.id')]
            if queue:matched.add(queue.pop())
            else:unmatched_completions.append(i)
    unmatched=[i for i,e in enumerate(rows) if e.get('event.name')=='codex.websocket_request' and i not in matched]
    subset=[e for i,e in enumerate(rows) if i not in unmatched]
    try:
        known=native.ledger(subset,calls)
        known['usageComplete']=False
        known['allNetworkRequestCount']+=len(unmatched)
        known['knownUsageOnly']=True
    except (AssertionError,ValueError) as error:
        known={'usageComplete':False,'knownSubsetError':str(error)}
    known.update({'observedSendRequests':sum(e.get('event.name')=='codex.websocket_request' for e in rows),
        'unmatchedObservedSends':[{'conversationId':rows[i].get('conversation.id'),'sentUnixNs':native.event_ns(rows[i]),
            'tokens':'unknown, NOT zero','purpose':'unverified; may be failed prewarm/retry, do not infer'} for i in unmatched],
        'unmatchedUsageCompletions':len(unmatched_completions),
        'costInterpretation':'Token sums cover observed usage-bearing completions only; incomplete total, never called full cost or invoice'})
    return known

def finish(wire, calls, native, timeout=30, stable_seconds=1.2):
    """Wait for observed sends, stop the producer, then audit its final flush.

    A quiet collector is insufficient: a late warmup during shutdown is included
    in the post-exit reconciliation. A real missing event remains a failure.
    """
    began=time.perf_counter(); stable=None; prior=None; settled=False
    last_error=None
    try:
        while time.perf_counter()-began<timeout:
            with wire.telemetry.lock:
                events=list(wire.telemetry.rows)
            try:
                ledger=reconcile(events,calls,native)
                current=(len(events),ledger['responseRequests'])
                if current!=prior:
                    stable=time.perf_counter()
                elif stable is not None and time.perf_counter()-stable>=stable_seconds:
                    settled=True
                    break
                prior=current
            except (AssertionError,ValueError) as e:
                last_error=type(e).__name__+': '+str(e)
                stable=prior=None
            time.sleep(.1)
    finally:
        wire.close()
    # close() waits for the owned producer and its telemetry exporter before
    # closing the collector. Audit the FINAL rows, including any shutdown send.
    exit_data=json.loads((wire.directory/'exit.json').read_text(encoding='utf-8'))
    producer_closed=exit_data['normal'] and exit_data['exitCode']==0 and exit_data['readerExited']
    try:
        ledger=reconcile(list(wire.telemetry.rows),calls,native)
        complete=True
    except (AssertionError,ValueError) as error:
        last_error=type(error).__name__+': '+str(error)
        ledger=partial_ledger(list(wire.telemetry.rows),calls,native)
        complete=False
    return {'status':'completed' if complete and producer_closed else 'accounting-incomplete',
            'quietBeforeExit':settled,'lastPreExitObservationError':last_error,
            'producerQuiescent':producer_closed,'postExitReconciled':complete,
            'costGatePassed':complete and producer_closed,'wallMs':(time.perf_counter()-began)*1000,
            'ledger':ledger,'countRule':'actual one-to-one native sends/completions plus exact question receipts, not2*questions',
            'reportAlwaysProduced':'Incomplete telemetry is an explicit failed cost gate; completed quality rows are preserved separately.'}

def regression():
    native=configure_transport()
    old=read('evaluation.json',OLD)
    events=old['ledger']['nativeEvents'];calls=old['modelCalls']
    actual=reconcile(events,calls,native)
    assert actual['responseRequests']==247 and actual['prewarmRequests']==123
    tests={'real247responses124questions':True}
    completion=next(e for e in events if e.get('event.kind')=='response.completed' and 'input_token_count' in e)
    bad={
        'missing_completion':[e for e in events if e is not completion],
        'duplicate_completion':[*events,completion],
        'unmatched_late_warmup':[*events,{**next(e for e in events if e.get('event.name')=='codex.websocket_request'),
            'event.timestamp':'2026-10-18T23:59:59.000Z'}],
    }
    for name,rows in bad.items():
        try:
            reconcile(rows,calls,native)
        except (AssertionError,ValueError):
            tests[name+'Rejected']=True
        else:
            raise AssertionError(name+' accepted')
    try:
        reconcile(events,calls[:-1],native)
    except AssertionError:
        tests['missing_question_receiptRejected']=True
    else:
        raise AssertionError('Missing question accepted')
    # Reassign only the synthetic warmup timing, without fabricating its tokens.
    # The real warmup and its real send remain one-to-one; it must still count.
    warm=next(r for r in actual['requests'] if r['role']=='prewarm')
    assert warm['totalTokens']>0
    tests['actual_prewarm_cost_nonzero']=True
    save('accounting-regression-v3.json',{'at':now(),'sourceSha256':digest(__file__),
        'oldRawSha256':digest(OLD/'evaluation.json'),'oldRawStatusPreserved':old['status'],
        'tests':tests,'qualityScorerChanged':False,'modelCalls':0,
        'actualRequests':actual['responseRequests'],'actualPrewarm':actual['prewarmRequests'],
        'totalTokens':actual['totalTokens'],'liveShutdownPath':'Pending live development canary'})
    print(json.dumps(tests))

def lifecycle_regression():
    """Synthetic shutdown scheduling around historical events; NOT live costs."""
    from datetime import datetime, timezone
    from types import SimpleNamespace
    import threading
    native=configure_transport();old=read('evaluation.json',OLD)
    events=old['ledger']['nativeEvents'];calls=old['modelCalls']
    stamp=max(native.event_ns(e) for e in events)+1_000_000_000
    thread=calls[-1]['receipt']['threadId']
    send={**next(e for e in events if e.get('event.name')=='codex.websocket_request'),
        'conversation.id':thread,'event.timestamp':datetime.fromtimestamp(stamp/1e9,timezone.utc).isoformat()}
    complete={**next(e for e in events if e.get('event.kind')=='response.completed' and e.get('output_token_count') in [0,'0']),
        'conversation.id':thread,'event.timestamp':datetime.fromtimestamp((stamp+100_000_000)/1e9,timezone.utc).isoformat()}
    class FakeWire:
        def __init__(self,name,tail):
            self.directory=WORK/name;self.directory.mkdir()
            self.telemetry=SimpleNamespace(rows=list(events),lock=threading.Lock())
            self.tail=tail
        def close(self):
            self.telemetry.rows.extend(self.tail)
            (self.directory/'exit.json').write_text(json.dumps({'normal':True,'exitCode':0,'readerExited':True}),encoding='utf-8')
    good=finish(FakeWire('synthetic-v3-final-warm',[send,complete]),calls,native,stable_seconds=.01)
    assert good['ledger']['responseRequests']==248 and good['ledger']['unusedFinalPrewarmRequests']==1
    assert good['ledger']['totalTokens']>old['ledger']['totalTokens']
    bad=finish(FakeWire('synthetic-v3-missing-final-usage',[send]),calls,native,stable_seconds=.01)
    rejected=bad['status']=='accounting-incomplete' and not bad['costGatePassed'] and not bad['ledger']['usageComplete']
    assert rejected and len(bad['ledger']['unmatchedObservedSends'])==1
    save('accounting-shutdown-regression-v3.json',{'at':now(),'syntheticOnly':True,'realNewModelCalls':0,
        'sourceSha256':digest(__file__),'lateFinalWarmIncluded':True,'unusedFinalWarmCount':1,
        'missingShutdownCompletionRejected':rejected,'note':'Fixture reuses historical token numbers to exercise accounting; NEVER added to real experiment cost.'})
    print('Synthetic shutdown: late unused warmup counted; missing final usage rejected.')

if __name__=='__main__':
    import sys
    lifecycle_regression() if '--shutdown' in sys.argv else regression()
