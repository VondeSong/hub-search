"""Two independent native HTTP turns; fail closed if config cannot select it."""
import json
import time
from accounting_support import WORK,save
from accounting_transport import Wire,ledger,secret_scan
from accounting_tcp import Sampler
from applicability_policy import POLICY,SCHEMA,validate_decisions

if __name__=='__main__':
    wire=sampler=None; rows=[]; failure=None; observed=None
    try:
        wire=Wire(WORK/'preflight-http-v2',http=True)
        sampler=Sampler(wire.process.pid)
        for i in [1,2]:
            memories=[{'id':'http-canary','project':'probe','status':'confirmed','text':'协议哨兵白桦盒确认采用靛青色。'}] if i==1 else []
            task={'id':'http-'+str(i),'project':'probe','question':'白桦盒确认采用什么颜色？','candidateIds':[m['id'] for m in memories]}
            payload={'project':{'id':'probe','name':'隔离协议探针'},'memories':memories,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            start=time.time_ns(); answer,receipt=wire.app_call(prompt,SCHEMA,WORK/f'preflight-http-v2-{i:02}'); end=time.time_ns()
            checked=validate_decisions(answer,[task],memories)[0]
            assert not checked['invalid'] and checked['ids']==(['http-canary'] if i==1 else [])
            rows.append({'id':task['id'],'startUnixNs':start,'endUnixNs':end,'receipt':receipt,'checked':checked})
        drain=wire.drain(2)
    except Exception as error:
        failure={'type':type(error).__name__,'message':str(error)[:200]}
    finally:
        if wire:
            wire.close()
        if sampler:
            observed=sampler.close()
    events=wire.telemetry.rows if wire else []
    result={'status':'completed' if failure is None else 'unavailable','failure':failure,'questions':rows,
            'ledger':ledger(events,rows) if failure is None else None,'nativeEvents':events,
            'configuration':'Custom native provider with no base URL override; requires OpenAI auth, supports_websockets=false. No private API client.',
            'remoteConnectionReuse':'Not established by HTTP capability alone; requires separate transport observation.',
            'credentialScan':secret_scan()}
    result['tcpObservation']=observed
    save('preflight-http-v2.json',result)
    print(json.dumps({'status':result['status'],'failure':failure,'questionCount':len(rows),
        'counts':{k:result['ledger'][k] for k in ['responseRequests','prewarmRequests','websocketConnects','httpEvents']} if result['ledger'] else None}))
