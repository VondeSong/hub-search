"""Remaining two preflight calls: identical real classification input, corrected collector."""
import json
from latency_support import WORK, PREVIOUS, ROOT, save
from latency_transport import Wire
from applicability_policy import SCHEMA, validate_decisions

if __name__=='__main__':
    questions=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    chosen=sorted(questions,key=lambda q:q['id'])[0]
    number=next(i+1 for i,q in enumerate(questions) if q['id']==chosen['id'])
    prompt=(ROOT/f'.local/hbm-00/passages-20261018/validation-{number:03}/input.txt').read_text(encoding='utf-8')
    payload=json.loads(prompt.split('待核验数据：\n',1)[1])
    results=[]
    for mode in ['cli','app']:
        wire=None
        try:
            wire=Wire(WORK/('instrument-probe-'+mode+'-v2'),mode,SCHEMA if mode=='cli' else None)
            if mode=='cli':
                response,receipt=wire.cli_call(prompt,SCHEMA)
            else:
                response,receipt=wire.app_call(prompt,SCHEMA,WORK/'instrument-probe-app-call-v2')
            checked=validate_decisions(response,payload['tasks'],payload['memories'])[0]
            assert not checked['invalid'] and set(checked['ids'])==set(chosen['expected'])
            results.append({'mode':mode,'receipt':receipt,'checked':checked})
        finally:
            if wire:
                wire.close()
    save('instrumentation-probe.json',{'status':'completed','results':results,
        'priorFailures':['Invalid quoted connector key rejected before initialize; process exited.',
                         '30s initialize timed out; late valid response at 36.18s proves startup actually continued.',
                         'First successful two-call semantic probe had telemetry body=null collector errors; those timing-export results unusable.'],
        'correction':'Connector names validated; initialize bound 60s following observed late result; no socket enumeration; nullable OTLP body handled.'})
    print(json.dumps({'status':'completed','model':'gpt-6.1-sol','effort':'xhigh'}))
