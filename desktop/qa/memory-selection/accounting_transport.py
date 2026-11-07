"""Owned native transports, safe per-response usage, and complete batch draining."""
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

import connection_transport as ct
from accounting_support import WORK,HOME,MODEL,EFFORT,digest
from passage_model import BASE

ct.WORK=WORK; ct.HOME=HOME; ct.legacy.WORK=WORK; ct.legacy_reuse.WORK=WORK
_settings=ct.legacy.settings
HTTP_MODE=False

def settings(directory,telemetry,ignore_user=False,telemetry_enabled=False):
    result=_settings(directory,telemetry,ignore_user=True,telemetry_enabled=telemetry_enabled)
    if HTTP_MODE:
        result+=['-c','model_provider="hbm_http"','-c',
                 'model_providers.hbm_http={name="HBM native HTTP",wire_api="responses",requires_openai_auth=true,supports_websockets=false}']
    return result

ct.legacy.settings=settings
def _popen(command,**kwargs):
    env=os.environ.copy()
    env.update({'CODEX_HOME':str(HOME),'CODEX_SQLITE_HOME':str(WORK/'shared-codex-state'),
                'TEMP':str(WORK/'tmp'),'TMP':str(WORK/'tmp'),
                'RUST_LOG':'warn,hyper_util::client::legacy::pool=trace'})
    for key in ['CODEX_API_KEY','OPENAI_API_KEY','CODEX_ACCESS_TOKEN']:
        env.pop(key,None)
    return subprocess.Popen(command,env=env,**kwargs)
ct.legacy.subprocess.Popen=_popen
_Telemetry=ct.legacy.Telemetry

class Telemetry(_Telemetry):
    ALLOW=_Telemetry.ALLOW|{'cache_write_token_count','tool_token_count','model_reasoning_effort','ttft_ms'}
    def consume(self,value):
        before=len(self.rows)
        records=[r for resource in value.get('resourceLogs',[]) for scope in resource.get('scopeLogs',[]) for r in scope.get('logRecords',[])]
        super().consume(value)
        fresh=self.rows[before:]
        assert len(records)==len(fresh)
        for record,row in zip(records,fresh):
            row['producerObservedTimeUnixNano']=record.get('observedTimeUnixNano')
            for attribute in record.get('attributes',[]):
                if attribute['key']=='endpoint':
                    endpoint=attribute.get('value',{}).get('stringValue','')
                    path=urlsplit(endpoint).path
                    row['endpointKind']='responses' if '/responses' in path else 'models' if '/models' in path else 'control'
                    row['endpointScheme']=urlsplit(endpoint).scheme
ct.legacy.Telemetry=Telemetry

def event_ns(row):
    if row.get('event.timestamp'):
        return round(datetime.fromisoformat(row['event.timestamp'].replace('Z','+00:00')).timestamp()*1e9)
    native=int(row.get('timeUnixNano') or row.get('producerObservedTimeUnixNano') or 0)
    if not native:
        native=int(row.get('producerObservedTimeUnixNano') or 0)
    if not native:
        raise ValueError('Native event time unavailable; collector delivery time is not a substitute')
    return native

class Wire(ct.Wire):
    def __init__(self,directory,http=False):
        global HTTP_MODE
        HTTP_MODE=http
        super().__init__(directory,telemetry_enabled=True)
        self.http=http

    def start_thread(self):
        began=time.perf_counter()
        setup=self.rpc('thread/start',{'model':MODEL,'allowProviderModelFallback':False,
            'cwd':str(WORK/'shared-cwd'),'ephemeral':True,'sandbox':'read-only','approvalPolicy':'never',
            'baseInstructions':BASE,'developerInstructions':'','dynamicTools':[],'serviceTier':'default',
            'config':{'model_reasoning_effort':EFFORT}})
        assert setup['model']==MODEL and setup['reasoningEffort']==EFFORT and setup['thread']['turns']==[]
        assert setup['modelProvider']==('hbm_http' if self.http else 'openai')
        return setup['thread']['id'],(time.perf_counter()-began)*1000,setup

    def drain(self,expected_completions,timeout=20):
        began=time.perf_counter(); stable_since=None; last_count=None
        while time.perf_counter()-began<timeout:
            with self.telemetry.lock:
                rows=list(self.telemetry.rows)
            count=sum(e.get('event.name')=='codex.sse_event' and e.get('event.kind')=='response.completed' and 'input_token_count' in e for e in rows)
            if count>=expected_completions:
                if count!=last_count:
                    stable_since=time.perf_counter()
                elif stable_since is not None and time.perf_counter()-stable_since>=1.2:
                    return {'status':'settled','responseCompletions':count,'expectedMinimum':expected_completions,
                            'drainMs':(time.perf_counter()-began)*1000}
            last_count=count; time.sleep(.1)
        raise TimeoutError('Complete response/prewarm accounting did not settle; do not infer missing tokens as zero')

ct.legacy_reuse.Wire=Wire

class ResetSession(ct.ReusableSession):
    def __init__(self,name,http=False):
        # The original constructor supplies a Wire signature; use a narrow local
        # adapter rather than changing any previous source or evidence.
        class ResetWire(Wire):
            def __init__(self,directory,mode='app',schema=None,telemetry_enabled=True):
                super().__init__(directory,http=http)
            def rpc(self,method,params,timeout=120):
                if method=='thread/start':
                    params={**params,'cwd':str(WORK/'shared-cwd')}
                return super().rpc(method,params,timeout)
        ct.legacy_reuse.Wire=ResetWire
        super().__init__(name,telemetry=True)

def ledger(telemetry,questions):
    rows=sorted([r for r in telemetry if r.get('event.name') in ['codex.websocket_connect','codex.websocket_request','codex.api_request','codex.sse_event']],key=event_ns)
    completions=[r for r in rows if r.get('event.kind')=='response.completed' and 'input_token_count' in r]
    output=[]
    for index,event in enumerate(completions,1):
        values={key:int(event[key]) for key in ['input_token_count','output_token_count','cached_token_count','reasoning_token_count']}
        candidates=[q for q in questions if q['receipt']['threadId']==event.get('conversation.id')
                    and q['startUnixNs']-2_000_000<=event_ns(event)<=q['endUnixNs']+2_000_000
                    and values['output_token_count']>0]
        assert len(candidates)<=1
        question=candidates[0] if candidates else None
        role='question' if question else 'prewarm'
        if not question:
            assert values['output_token_count']==0
        else:
            actual=question['receipt']['usage']
            assert [values[k] for k in ['input_token_count','output_token_count','cached_token_count','reasoning_token_count']]==[actual[k] for k in ['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens']]
        earlier=[e for e in rows if e.get('event.name')=='codex.websocket_request' and e.get('conversation.id')==event.get('conversation.id') and event_ns(e)<=event_ns(event)]
        # New native WS sends strictly serial requests per conversation; nearest
        # earlier send is this response. HTTP API event is a separate header-stage
        # boundary and must not be invented as an exact stream-send timestamp.
        sent=earlier[-1] if earlier else None
        http_earlier=[e for e in rows if e.get('event.name')=='codex.api_request' and e.get('conversation.id')==event.get('conversation.id') and event_ns(e)<=event_ns(event)]
        http_request=http_earlier[-1] if not sent and http_earlier else None
        sent_ns=event_ns(sent) if sent else event_ns(http_request)-int(http_request['duration_ms'])*1_000_000 if http_request else None
        output.append({'number':index,'role':role,'questionId':question['id'] if question else None,
            'conversationId':event.get('conversation.id'),'completedUnixNs':event_ns(event),
            'sentUnixNs':sent_ns,'sendBoundary':'native-ws-send' if sent else 'native-http-duration-derived' if http_request else 'unknown',
            'requestToCompletionMs':(event_ns(event)-sent_ns)/1e6 if sent_ns else None,
            'tokens':values,'totalTokens':values['input_token_count']+values['output_token_count']})
    assert sum(r['role']=='question' for r in output)==len(questions)
    questions_by_thread={q['receipt']['threadId'] for q in questions}
    for row in output:
        row['unusedFinalPrewarm']=row['role']=='prewarm' and row['conversationId'] in questions_by_thread and not any(q['receipt']['threadId']==row['conversationId'] and q['endUnixNs']>row['completedUnixNs'] for q in questions)
    sends=sum(r.get('event.name')=='codex.websocket_request' for r in rows)
    if sends:
        assert sends==len(output), 'Incomplete WS request accounting'
    physical=[r for r in rows if r.get('event.name')=='codex.api_request' and 'auth.mode' in r.get('attributeNames',[])]
    controls=[r for r in physical if r.get('endpointKind')!='responses']
    semantic=[r for r in rows if r.get('event.name')=='codex.api_request' and r.get('conversation.id')]
    physical_responses=[r for r in physical if r.get('endpointKind')=='responses']
    canonical_http_response_count=max(len(semantic),len(physical_responses))
    return {'requests':output,'nativeEvents':rows,'responseRequests':len(output),
        'controlRequests':[{'endpointKind':e.get('endpointKind'),'completedUnixNs':event_ns(e),
                            'durationMs':int(e['duration_ms']),'status':e.get('http.response.status_code'),
                            'tokens':'not-applicable-to-control-request'} for e in controls],
        'allNetworkRequestCount':len(controls)+canonical_http_response_count+sum(r.get('event.name') in ['codex.websocket_connect','codex.websocket_request'] for r in rows),
        'canonicalHttpResponseRequests':canonical_http_response_count,
        'prewarmRequests':sum(r['role']=='prewarm' for r in output),
        'unusedFinalPrewarmRequests':sum(r['unusedFinalPrewarm'] for r in output),
        'httpEvents':sum(r.get('event.name')=='codex.api_request' for r in rows),
        'physicalHttpRequests':sum(r.get('event.name')=='codex.api_request' and 'auth.mode' in r.get('attributeNames',[]) for r in rows),
        'semanticHttpRequestEvents':sum(r.get('event.name')=='codex.api_request' and 'conversation.id' in r for r in rows),
        'websocketConnects':sum(r.get('event.name')=='codex.websocket_connect' for r in rows),
        'totalInputTokens':sum(r['tokens']['input_token_count'] for r in output),
        'totalOutputTokens':sum(r['tokens']['output_token_count'] for r in output),
        'cachedInputTokens':sum(r['tokens']['cached_token_count'] for r in output),
        'totalTokens':sum(r['totalTokens'] for r in output),'usageComplete':True,
        'missingHttpRequestSendTimes':sum(r['sentUnixNs'] is None for r in output),
        'interpretation':'All response usage including prewarm. Connect/send/completion are distinct stages, not three inference requests. Tokens are workload, not an invoice.'}

secret_scan=ct.secret_scan
