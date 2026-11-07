"""Two real text calls on one persistent process; isolated tool-free semantic preflight."""
import json
from latency_support import WORK, save
from latency_transport import Wire

if __name__=='__main__':
    wire=None
    try:
        wire=Wire(WORK/'preflight-server-v4','app')
        schema={'type':'object','properties':{'value':{'type':'string'}},'required':['value'],'additionalProperties':False}
        results=[]
        for i,word in enumerate(['first','second'],1):
            response,receipt=wire.app_call('Return JSON with value exactly '+word+'.',schema,WORK/f'preflight-{i:02}')
            assert response=={'value':word}
            results.append(receipt)
        save('preflight.json',{'status':'completed','calls':results,
            'sessionReuseExcluded':'Current documented thread/rollback removed; revert unsupported for ephemeral. Use fresh ephemeral threads, never prior history.',
            'initializeMs':wire.initialize_ms})
        print(json.dumps({'status':'completed','initializeMs':wire.initialize_ms,
            'callMs':[r['durationMs'] for r in results],'firstAnswerMs':[r['submitToFirstAnswerDeltaMs'] for r in results]}))
    finally:
        if wire:
            wire.close()
