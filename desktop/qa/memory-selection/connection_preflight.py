"""Two canary turns: isolated persistence, formal history removal, observed remote reuse."""
import json
from applicability_policy import POLICY,SCHEMA,validate_decisions
from connection_support import WORK,save
from connection_transport import ReusableSession,secret_scan

if __name__=='__main__':
    session=None
    rows=[]
    try:
        session=ReusableSession('preflight-reuse-v2',telemetry=True)
        for i in [1,2]:
            memories=[{'id':'canary-memory','project':'probe','status':'confirmed',
                       'text':'隔离测试用的墨桥箱确认颜色为靛蓝。'}] if i==1 else []
            task={'id':'canary-'+str(i),'project':'probe','question':'墨桥箱确认是什么颜色？',
                  'candidateIds':[m['id'] for m in memories]}
            payload={'project':{'id':'probe','name':'合成隔离预检'},'memories':memories,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            answer,receipt=session.call(prompt,SCHEMA,WORK/f'preflight-v2-{i:02}')
            checked=validate_decisions(answer,[task],memories)[0]
            assert not checked['invalid'] and checked['ids']==(['canary-memory'] if i==1 else [])
            rows.append({'checked':checked,'receipt':receipt})
    finally:
        if session:
            session.close()
    scan=secret_scan()
    assert not scan['credentialPersisted'] and not scan['authFileCopied']
    save('preflight.json',{'status':'completed','rows':rows,'secretScan':scan,
                           'connectionEvents':[e for e in session.wire.telemetry.rows if e.get('event.name') in ['codex.websocket_connect','codex.websocket_request']]})
    print(json.dumps({'status':'completed','calls':len(rows),'isolatedHistoryVerified':True,
                     'connections':[{k:e.get(k) for k in ['event.name','duration_ms','auth.connection_reused']} for e in session.wire.telemetry.rows if e.get('event.name') in ['codex.websocket_connect','codex.websocket_request']]}))
