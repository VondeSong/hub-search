"""Four diagnostic calls only: transport telemetry, no method selection from these probes."""
from datetime import datetime
import json
from pathlib import Path

from applicability_policy import POLICY, SCHEMA, validate_decisions
from latency_support import ROOT, WORK, PREVIOUS, save, digest
from latency_transport import Wire


if __name__=='__main__':
    questions=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    chosen=sorted(questions,key=lambda q:q['id'])[:2]
    save('profile-contract.json',{'calls':4,'cases':[q['id'] for q in chosen],
        'purpose':'Attribute observed phases and remote WebSocket setup/reuse; never use these four outcomes to alter transport selection.',
        'collectorSha256':digest(Path(__file__).with_name('latency_transport.py')),
        'privacy':'Allowlisted times/event types and boolean reuse only; no auth headers/tokens/resources/prompts exported.',
        'limits':'Connection setup excludes remote inference, but first-output wait includes network, scheduling, prefill and hidden reasoning; those cannot be split here.'})
    persistent=None
    rows=[]
    try:
        persistent=Wire(WORK/'profile-persistent','app',telemetry_enabled=True)
        for i,q in enumerate(chosen,1):
            number=questions.index(q)+1
            prompt=(ROOT/f'.local/hbm-00/passages-20261018/validation-{number:03}/input.txt').read_text(encoding='utf-8')
            payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
            order=['cli','persistent'] if i==1 else ['persistent','cli']
            for mode in order:
                local=None
                try:
                    if mode=='cli':
                        local=Wire(WORK/f'profile-{i:02}-cli','cli',SCHEMA,telemetry_enabled=True)
                        response,receipt=local.cli_call(prompt,SCHEMA)
                    else:
                        response,receipt=persistent.app_call(prompt,SCHEMA,WORK/f'profile-{i:02}-persistent')
                    checked=validate_decisions(response,payload['tasks'],payload['memories'])[0]
                    assert not checked['invalid']
                    rows.append({'id':q['id'],'mode':mode,'receipt':receipt,'checked':checked})
                finally:
                    if local:
                        local.close()
    finally:
        if persistent:
            persistent.close()
    events=[]
    for root in [WORK/'profile-persistent',WORK/'profile-01-cli',WORK/'profile-02-cli']:
        for event in json.loads((root/'telemetry.json').read_text(encoding='utf-8')):
            events.append({'owner':root.name,**event})
    names=['codex.api_request','codex.websocket_connect','codex.websocket_request',
           'codex.turn_ttft','codex.sse_event','codex.startup_phase']
    relevant=[e for e in events if e.get('event.name') in names]
    save('profile.json',{'status':'completed','results':rows,'events':relevant,
        'remoteConnectionEvents':[e for e in relevant if e.get('event.name')=='codex.websocket_connect'],
        'attributionLimit':'No server-side timing. Do not subtract latency medians or label first reasoning item as start/end of hidden inference.',
        'measurementCondition':'Shared experiment-owned native metadata state already initialized, local OTel collector only for these four diagnostic calls.'})
    print(json.dumps({'status':'completed','events':len(relevant),
        'connects':[{'owner':e['owner'],'durationMs':e.get('duration_ms'),'reused':e.get('auth.connection_reused')}
                   for e in relevant if e.get('event.name')=='codex.websocket_connect']}))
