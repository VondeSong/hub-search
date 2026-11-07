"""Correlate exact owned native request markers with host output timestamps."""
import json
import re
import sqlite3
from connection_support import ROOT,WORK,PREVIOUS,save,read

def correlate(directory,process,receipt,log_path,start_ns=None,end_ns=None):
    events=json.loads((directory/'events.json').read_text(encoding='utf-8'))
    submit=max(e['ms'] for e in events)-receipt['submitToCompletionMs']
    host_ns=lambda ms:process['beganUnixNs']+round(ms*1e6)
    if start_ns is None:
        start_ns=host_ns(submit)
    if end_ns is None:
        end_ns=host_ns(max(e['ms'] for e in events))
    con=sqlite3.connect(log_path.resolve().as_uri()+'?mode=ro',uri=True)
    rows=con.execute('SELECT ts,ts_nanos,level,target,feedback_log_body FROM logs WHERE ts BETWEEN ? AND ? AND thread_id=? ORDER BY ts,ts_nanos',
                     (int(start_ns/1e9)-1,int(end_ns/1e9)+1,receipt['threadId'])).fetchall()
    con.close()
    native=[(sec*1_000_000_000+ns,level,target,body or '') for sec,ns,level,target,body in rows]
    native=[r for r in native if start_ns<=r[0]<=end_ns]
    request=[r[0] for r in native if r[2]=='codex_core::client' and 'websocket.warmup=false' in r[3] and 'non-incremental request' in r[3]]
    reasoning=[r[0] for r in native if r[2]=='codex_core::stream_events_utils' and 'Output item item_type="reasoning"' in r[3] and 'handle_output_item_done' not in r[3]]
    messages=[r[0] for r in native if r[2]=='codex_core::stream_events_utils' and 'Output item item_type="message"' in r[3] and 'handle_output_item_done' not in r[3]]
    observed=[host_ns(e['ms']) for e in events if e['event'].get('method')=='item/started' and e['event'].get('params',{}).get('item',{}).get('type')=='reasoning']
    first_answer=receipt['submitToFirstAnswerDeltaMs']
    first_reason=receipt['submitToFirstReasoningItemMs']
    regex=re.compile(r'\b(?:retrying|retry attempt|timed out|stream error|connection failed)\b',re.I)
    errors=[{'unixNs':r[0],'level':r[1],'target':r[2],'kind':'explicit-error-or-retry-marker'} for r in native if regex.search(r[3])]
    return {'threadId':receipt['threadId'],'turnId':receipt['turnId'],
        'submitUnixNs':host_ns(submit),'formalRequestMarkersUnixNs':request,
        'nativeFirstReasoningUnixNs':reasoning[0] if reasoning else None,
        'nativeFirstMessageUnixNs':messages[0] if messages else None,
        'formalMarkerToFirstNativeItemMs':(min(reasoning+messages)-request[0])/1e6 if request and reasoning+messages else None,
        'submitToFormalMarkerMs':(request[0]-host_ns(submit))/1e6 if request else None,
        'nativeToHostFirstReasoningMs':(observed[0]-reasoning[0])/1e6 if observed and reasoning else None,
        'submitToFirstReasoningMs':first_reason,'submitToFirstAnswerMs':first_answer,
        'firstAnswerToCompletedMs':receipt['submitToCompletionMs']-first_answer if first_answer else None,
        'threadSetupMs':receipt.get('threadSetupMs'),'historyResetMs':receipt.get('historyResetMs'),
        'usage':receipt['usage'],'explicitErrorRetryMarkers':errors,
        'nativeLogRowsInWindow':len(native),
        'limit':'Formal request log is a client stream-construction marker, not proof of server acceptance. Absence of retry markers is limited by log coverage. Network/queue/prefill/hidden inference remain inseparable.'}

if __name__=='__main__':
    prior=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))['results']
    process=json.loads((ROOT/'.local/hbm-00/latency-20261018/validation-persistent/process.json').read_text(encoding='utf-8'))
    old=[]
    for number,row in sorted(enumerate(prior,1),key=lambda t:-t[1]['endToEndMs'])[:3]:
        old.append({'number':number,'id':row['id'],'e2eMs':row['endToEndMs'],
                    **correlate(ROOT/f'.local/hbm-00/latency-20261018/validation-{number:03}',process,row['modelReceipt'],ROOT/'.local/hbm-00/latency-20261018/shared-codex-state/logs_2.sqlite')})
    save('prior-phases.json',{'rows':old,'networkVsInferenceResolved':False,
         'finding':'Longest prior tail is dominated by pre-output request wait; correlate native and host clocks rather than treating the logger function name try_run_sampling_request as a retry.'})
    print(json.dumps(old,ensure_ascii=False))
