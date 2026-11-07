"""Conditional native HTTP history reset, with pool-only diagnostics and no new grant."""
import json
import sqlite3
import time
from accounting_support import WORK,save
from accounting_transport import ResetSession,ledger,secret_scan
from accounting_tcp import Sampler
from applicability_policy import POLICY,SCHEMA,validate_decisions

if __name__=='__main__':
    save('transport-observation-addendum.json',{'beforeConditionalProbe':True,'remainingPreflightTurns':4,
        'candidate':'If HTTP fresh threads do not prove reuse, test the same native HTTP persistent thread with formal history reset (2 turns), within original 8-turn preflight cap.',
        'observation':'Pool-only Rust trace target, no HTTP headers or TLS payload interception. IP Helper samples owned PID only, validated below 100ms per query.',
        'reuseGate':'Prefer native pool reuse/checkout evidence correlated to distinct independent turns. Socket persistence alone to the local proxy cannot prove its upstream connection; report that limit. Do not call HTTP/TLS reuse WebSocket reuse.',
        'costGate':'All response completions with usage, native event clock including SDK emission time for metadata; never collector delivery. No criterion lowered.'})
    session=sampler=None; rows=[]; failure=None
    try:
        session=ResetSession('preflight-reset-http',http=True)
        sampler=Sampler(session.wire.process.pid)
        for i in [1,2]:
            memories=[{'id':'reset-http-canary','project':'probe','status':'confirmed','text':'隔离探针青松袋确认装有白色卡片。'}] if i==1 else []
            task={'id':'reset-http-'+str(i),'project':'probe','question':'青松袋确认装的是什么颜色的卡片？','candidateIds':[m['id'] for m in memories]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps({'project':{'id':'probe','name':'隔离预检'},'memories':memories,'tasks':[task]},ensure_ascii=False)
            start=time.time_ns(); response,receipt=session.call(prompt,SCHEMA,WORK/f'preflight-reset-http-{i:02}'); end=time.time_ns()
            checked=validate_decisions(response,[task],memories)[0]
            assert not checked['invalid'] and checked['ids']==(['reset-http-canary'] if i==1 else [])
            rows.append({'id':task['id'],'startUnixNs':start,'endUnixNs':end,'receipt':receipt,'checked':checked})
        drain=session.wire.drain(2)
    except Exception as error:
        failure={'type':type(error).__name__,'message':str(error)[:250]}
    finally:
        if session:
            session.close()
        observed=sampler.close() if sampler else None
    events=session.wire.telemetry.rows if session else []
    log=WORK/'shared-codex-state/logs_2.sqlite'
    con=sqlite3.connect(log.resolve().as_uri()+'?mode=ro',uri=True)
    native=con.execute("SELECT ts,ts_nanos,thread_id,target,feedback_log_body FROM logs WHERE target LIKE 'hyper_util%pool%' ORDER BY ts,ts_nanos").fetchall()
    con.close()
    # This specific target logs pool metadata only, never request bodies/headers.
    pool=[{'unixNs':sec*1_000_000_000+ns,'threadId':thread,'target':target,'body':body[-1600:]} for sec,ns,thread,target,body in native]
    scan=secret_scan(); assert not scan['credentialPersisted'] and not scan['authFileCopied']
    result={'status':'completed' if failure is None else 'unavailable','failure':failure,'questions':rows,
            'ledger':ledger(events,rows) if failure is None else None,'tcpObservation':observed,'poolEvents':pool,'credentialScan':scan}
    save('preflight-reset-http.json',result)
    print(json.dumps({'status':result['status'],'failure':failure,'turns':len(rows),'poolEvents':len(pool),
        'poolMessages':[r['body'].split('}:')[-1] for r in pool][-12:]},ensure_ascii=True))
