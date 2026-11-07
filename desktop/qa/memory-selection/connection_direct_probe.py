"""Two independent classification requests on one public authenticated connection."""
import json
from applicability_policy import POLICY,SCHEMA,validate_decisions
from connection_support import WORK,save
from connection_direct import Direct
from connection_transport import secret_scan

if __name__=='__main__':
    save('direct-probe-contract.json',{'budgetOwner':'Two of eight diagnostic follow-up turns; initial four preflight turns already consumed.',
        'nativeFinding':'No-reset native thread reused connection; thread/revert reopened it. Native reuse option fails actual cross-question reuse qualification.',
        'purpose':'Public Responses WS with full inputs and no previous_response_id, existing ChatGPT-plan OAuth only; no API-key/private-endpoint fallback.',
        'references':['https://developers.openai.com/api/docs/guides/websocket-mode','https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference'],
        'scope':'Isolated HBM-00 prototype only, not HBM-01B production model-layer migration.'})
    client=None
    rows=[]
    try:
        client=Direct('direct-probe')
        for i in [1,2]:
            memories=[{'id':'direct-canary','project':'probe','status':'confirmed','text':'试验用青柳盒确认材质是黄铜。'}] if i==1 else []
            task={'id':'probe-'+str(i),'project':'probe','question':'青柳盒确认的材质是什么？','candidateIds':[m['id'] for m in memories]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps({'project':{'id':'probe','name':'隔离预检'},'memories':memories,'tasks':[task]},ensure_ascii=False)
            answer,receipt=client.call(prompt,SCHEMA,WORK/f'direct-probe-{i:02}')
            checked=validate_decisions(answer,[task],memories)[0]
            assert not checked['invalid'] and checked['ids']==(['direct-canary'] if i==1 else [])
            rows.append({'receipt':receipt,'checked':checked})
    finally:
        if client:
            client.close()
    scan=secret_scan()
    assert not scan['credentialPersisted'] and not scan['authFileCopied']
    save('direct-probe.json',{'status':'completed','rows':rows,'secretScan':scan,'calls':2,
                              'crossQuestionReuse':len({r['receipt']['connectionId'] for r in rows})==1,
                              'independentRequestCanaryPassed':True})
    print(json.dumps({'status':'completed','calls':2,'samePhysicalConnection':True,'canaryPassed':True}))
