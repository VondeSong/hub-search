"""Two protocol-only turns without reset; not an eligible memory-selection strategy."""
import json
import time
from connection_support import WORK,MODEL,EFFORT,save
from connection_transport import Wire,secret_scan

if __name__=='__main__':
    wire=None
    try:
        wire=Wire(WORK/'continuity-no-reset',telemetry_enabled=True)
        thread,_,setup=wire.start_thread()
        rows=[]
        schema={'type':'object','properties':{'value':{'type':'string'}},'required':['value'],'additionalProperties':False}
        for i in [1,2]:
            result=wire.rpc('turn/start',{'threadId':thread,'model':MODEL,'effort':EFFORT,'summary':'none',
                'input':[{'type':'text','text':'Return JSON with value exactly '+str(i)+'.'}],
                'outputSchema':schema,'serviceTierForTurn':'default'})
            tid=result['turn']['id']
            pending=wire.pending
            wire.pending=[]
            messages=[]
            deadline=time.monotonic()+120
            while True:
                row=pending.pop(0) if pending else wire.next(deadline)
                e=row['event']; p=e.get('params',{})
                if p.get('threadId')!=thread:
                    continue
                if e.get('method')=='item/completed' and p.get('item',{}).get('type')=='agentMessage':
                    messages.append(p['item']['text'])
                if e.get('method')=='turn/completed' and p['turn']['id']==tid:
                    assert p['turn']['status']=='completed'
                    break
            assert len(messages)==1 and json.loads(messages[0])=={'value':str(i)}
            rows.append({'turnId':tid,'valueCorrect':True})
        wire.rpc('thread/unsubscribe',{'threadId':thread})
    finally:
        if wire:
            wire.close()
    save('continuity-no-reset.json',{'status':'completed','calls':2,'rows':rows,'memoryStrategyEligible':False,
        'purpose':'Discriminate reset-triggered reconnect from normal multi-turn behavior; not used for independent-question validation.',
        'connectionEvents':[e for e in wire.telemetry.rows if e.get('event.name') in ['codex.websocket_connect','codex.websocket_request']]})
    print(json.dumps({'calls':2,'connects':[{k:e.get(k) for k in ['event.name','duration_ms','auth.connection_reused']} for e in wire.telemetry.rows if e.get('event.name') in ['codex.websocket_connect','codex.websocket_request']]}))
