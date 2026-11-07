"""Native producer-clock boundaries of observed tails, no second latency run."""
import json
from accounting_support import read,save
from accounting_transport import event_ns

if __name__=='__main__':
    evaluation=read('evaluation.json'); ledger=evaluation['fullModelLedger']; result=[]
    for number,row in sorted(enumerate(evaluation['results'],1),key=lambda t:-t[1]['endToEndMs'])[:3]:
        receipt=row['modelReceipt']; thread=receipt['threadId']
        request=next(r for r in ledger['requests'] if r['questionId']==row['id'])
        sent=request['sentUnixNs']; completed=request['completedUnixNs']
        events=[e for e in ledger['nativeEvents'] if e.get('conversation.id')==thread]
        outputs=sorted([event_ns(e) for e in events if e.get('event.kind')=='response.output_text.delta' and sent<=event_ns(e)<=completed])
        first=outputs[0] if outputs else None
        connects=[{'durationMs':float(e['duration_ms']),'completedUnixNs':event_ns(e)} for e in events if e.get('event.name')=='codex.websocket_connect']
        prewarm=[r for r in ledger['requests'] if r['conversationId']==thread and r['role']=='prewarm']
        result.append({'number':number,'id':row['id'],'endToEndMs':row['endToEndMs'],'retrievalMs':row['retrievalMs'],
           'threadSetupMs':receipt['threadSetupMs'],'modelMs':row['modelMs'],
           'hostModelStartToNativeFormalSendMs':(sent-row['modelStartUnixNs'])/1e6,
           'nativeFormalSendToFirstNativeAnswerDeltaMs':(first-sent)/1e6 if first else None,
           'nativeFirstAnswerToCompletedMs':(completed-first)/1e6 if first else None,
           'nativeFormalSendToCompletedMs':(completed-sent)/1e6,
           'nativeCompletedToHostModelReturnMs':(row['modelEndUnixNs']-completed)/1e6,
           'nativeFirstAnswerBoundaryAvailable':bool(first),'nativeConnects':connects,
           'prewarm':prewarm,
           'hostSubmitToFirstReasoningMs':receipt.get('submitToFirstReasoningItemMs'),
           'hostSubmitToFirstAnswerMs':receipt.get('submitToFirstAnswerDeltaMs')})
    save('tail-native-boundaries.json',{'rows':result,'eventClock':'Native producer event.timestamp; never collector-arrival time.',
       'limits':'Formal-send to first-answer delay combines transport, upstream queue, input prefill and hidden reasoning. These boundaries do not identify pure model inference or a single cause; no replay or tuning performed.'})
    print(json.dumps(result,ensure_ascii=False))
