"""Whole-round accounting, including failed telemetry preflight and unused warmups."""
from collections import Counter
from datetime import datetime
import json
from accounting_support import WORK,read,save
from accounting_transport import ledger,event_ns

def local(path): return json.loads(path.read_text(encoding='utf-8'))

if __name__=='__main__':
    # Initial HTTP preflight completed two turns, then failed while accounting a
    # control event without a native timestamp. Preserve that failure and count
    # all actual completions; never rerun it or substitute collector time.
    events=local(WORK/'preflight-http/telemetry.json')
    receipts=[local(WORK/f'preflight-http-{i:02}/receipt.json') for i in [1,2]]
    responses=[]
    for e in events:
        if e.get('event.kind')!='response.completed' or 'input_token_count' not in e: continue
        receipt=next(r for r in receipts if r['threadId']==e['conversation.id'])
        values={k:int(e[k]) for k in ['input_token_count','output_token_count','cached_token_count','reasoning_token_count']}
        assert values['input_token_count']==receipt['usage']['inputTokens']
        responses.append({'role':'question','questionId':e['conversation.id'],
           'completedUnixNs':event_ns(e),'requestToCompletionMs':receipt['submitToCompletionMs'],
           'sendBoundary':'client-submit-duration-only-no-exact-initial-native-send-boundary',
           'tokens':values,'totalTokens':values['input_token_count']+values['output_token_count'],
           'unusedFinalPrewarm':False})
    physical=[e for e in events if e.get('event.name')=='codex.api_request' and 'auth.mode' in e.get('attributeNames',[])]
    semantic=[e for e in events if e.get('event.name')=='codex.api_request' and e.get('conversation.id')]
    initial={'responseRequests':len(responses),'prewarmRequests':0,'unusedFinalPrewarmRequests':0,
       'allNetworkRequestCount':len(physical) if len(physical)>=len(semantic) else len(semantic),
       'totalInputTokens':sum(r['tokens']['input_token_count'] for r in responses),
       'totalOutputTokens':sum(r['tokens']['output_token_count'] for r in responses),
       'cachedInputTokens':sum(r['tokens']['cached_token_count'] for r in responses),
       'totalTokens':sum(r['totalTokens'] for r in responses),'requests':responses,'usageComplete':len(responses)==2,
       'physicalHttpRequestsDetails':[{'number':i,'durationMs':float(e['duration_ms']),
          'status':e.get('http.response.status_code'),'completedUnixNs':event_ns(e) if e.get('event.timestamp') else None,
          'endpointKind':e.get('endpointKind','not-captured-in-initial-preflight'),
          'generationUsage':'Inference usage is matched separately to the two completed responses; not counted twice.'} for i,e in enumerate(physical,1)],
       'missingControlNativeTimestamp':sum(e.get('event.name')=='codex.api_request' and not e.get('event.timestamp') for e in events),
       'limitation':'The first preflight failed only in control-event timestamp accounting. Preserve unknown control timestamps; no collector clock substitution. Included in round cost, excluded from matched comparison.'}
    groups=[{'name':'initial-http-accounting-failure','formalTurns':2,'ledger':initial,
             'wholeBatchWallMs':local(WORK/'preflight-http/exit.json')['totalMs']}]
    for filename,folder in [('preflight-http-v2.json','preflight-http-v2'),('preflight-reset-http.json','preflight-reset-http')]:
        r=read(filename)
        groups.append({'name':folder,'formalTurns':2,'ledger':r['ledger'],
                       'wholeBatchWallMs':local(WORK/folder/'exit.json')['totalMs']})
    dev=read('development-raw.json')
    for batch in dev['batches']:
        groups.append({'name':batch['name'],'formalTurns':4,'ledger':batch['ledger'],
            'wholeBatchWallMs':batch['wholeBatchWallMs'],'actualUserGapsMs':batch['actualUserGapsMs']})
    evaluation=read('evaluation.json'); assert evaluation['status']=='completed'
    groups.append({'name':'new-frozen-140','formalTurns':140,'ledger':evaluation['fullModelLedger'],
       'wholeBatchWallMs':evaluation['totalMs'],'modelBatchWallMs':evaluation['modelBatchWallMs']})
    totals={k:sum(g['ledger'][k] for g in groups) for k in ['responseRequests','prewarmRequests','unusedFinalPrewarmRequests',
       'allNetworkRequestCount','totalInputTokens','totalOutputTokens','cachedInputTokens','totalTokens']}
    totals.update({'formalTurns':sum(g['formalTurns'] for g in groups),
       'sumOwnedExperimentWallMs':sum(g['wholeBatchWallMs'] for g in groups),
       'scheduledThinkTimeMs':sum(g.get('actualUserGapsMs',0) for g in groups)})
    public=[]
    for f in ['public-admission.json','public-admission-v2.json']:
        for request in read(f)['requests']:
            public.append({'run':f,**request,'generationTokens':0,'generationRequests':0})
    totals['publicAdmissionRequests']=len(public)
    totals['allNetworkRequestsIncludingPublicAdmission']=totals['allNetworkRequestCount']+len(public)
    totals['publicAdmissionWaitMs']=sum(r['durationMs'] for r in public)
    assert totals['formalTurns']==194 and totals['responseRequests']==totals['formalTurns']+totals['prewarmRequests']
    save('complete-round-cost.json',{'totals':totals,'groups':groups,'publicAdmission':public,
       'scope':'All child model requests including preflight with failed accounting, comparison, frozen run, every prewarm and unused final prewarm. Primary agent authoring/tool-orchestration token usage is not exposed by child receipts and is not represented as zero.',
       'clock':'Native producer event timestamps for inference. Native SDK emission time only where the semantic control event has none; initial missing values remain unknown. Never collector-arrival time. Wall time uses host monotonic clock.',
       'costMeaning':'Input+output processed tokens; cached input and reasoning output are subsets, no double counting and no dollar billing claim.',
       'thinkTimeMeaning':'Think-time gaps can hide warmup from user waiting; neither generation usage nor request counts are free.',
       'noUnreportedChildCalls':True})
    print(json.dumps(totals,ensure_ascii=False))
