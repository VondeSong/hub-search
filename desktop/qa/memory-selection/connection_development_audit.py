"""Repair event attribution, without rerunning models or changing the actor.

This runtime emits OTel timeUnixNano=0. The allowlisted native event.timestamp
is authoritative; delivery/observed time can lag and is not a request timestamp.
Keep the first invalid development summary as an audit artifact.
"""
from datetime import datetime
import json
import statistics
from connection_support import REPORTS,read,save,digest
from connection_develop import sources,stats

if __name__=='__main__':
    raw=read('development-raw.json'); contract=read('development-contract.json')
    assert raw['status']=='completed' and len(raw['results'])==48 and sources()==contract['actorSources']
    events=raw['events']
    assert events and all(int(e.get('timeUnixNano') or 0)==0 for e in events)
    stamp=lambda e:round(datetime.fromisoformat(e['event.timestamp'].replace('Z','+00:00')).timestamp()*1e9)
    rows=raw['results']
    for row in rows:
        row['remoteEvents']=[e for e in events if e.get('conversation.id')==row['receipt']['threadId']
                             and row['startUnixNs']-1_000_000<=stamp(e)<=row['endUnixNs']+1_000_000]
    by_mode={mode:[r for r in rows if r['mode']==mode] for mode in ['persistent','reset']}
    thread_ids={mode:{r['receipt']['threadId'] for r in rr} for mode,rr in by_mode.items()}
    assert len(thread_ids['persistent'])==24 and len(thread_ids['reset'])==1
    assert not thread_ids['persistent']&thread_ids['reset']
    connections={mode:[e for e in events if e['event.name']=='codex.websocket_connect' and e['conversation.id'] in tids]
                 for mode,tids in thread_ids.items()}
    counts={mode:len(ee) for mode,ee in connections.items()}
    assert counts['persistent']==24 and counts['reset']>=24
    assert all(e['auth.connection_reused'] is False for ee in connections.values() for e in ee)
    assert all(any(e['event.name']=='codex.websocket_request' and e['auth.connection_reused'] for e in r['remoteEvents']) for r in rows)
    assert all(r['correct'] for r in rows)
    base={(r['round'],r['id']):r['callMs'] for r in by_mode['persistent']}
    savings=[1-r['callMs']/base[(r['round'],r['id'])] for r in by_mode['reset']]
    background=[{'event':e,'overlappingBaselineCases':[{'round':r['round'],'id':r['id']}
                 for r in by_mode['persistent'] if r['startUnixNs']-1_000_000<=stamp(e)<=r['endUnixNs']+1_000_000]}
                for e in connections['reset']
                if not any(r['startUnixNs']-1_000_000<=stamp(e)<=r['endUnixNs']+1_000_000 for r in by_mode['reset'])]
    save('development-audit.json',{'status':'completed','observations':48,'results':rows,
        'correction':'Original summary misattributed events because this runtime sends timeUnixNano=0. Use native event.timestamp plus conversation identity; do not use delayed collector delivery time. No new model calls or timing/policy changes.',
        'invalidSummarySha256':digest(REPORTS/'development.json'),'rawSha256':digest(REPORTS/'development-raw.json'),
        'timing':{mode:stats([r['callMs'] for r in rr]) for mode,rr in by_mode.items()},
        'nativeConnectCounts':counts,'connections':connections,'samePid':len({r['receipt']['pid'] for r in rows})==1,
        'resetConnectEventsOutsideOwnCallWindow':background,
        'timingConfound':'Revert can start the next prewarm before the next reset-mode call. Background reset connections overlap baseline calls. The nominal per-call timing shifts setup outside its own boundary and is not a causal steady-state speedup.',
        'exactOutcomes':48,'pairedMedianSaving':statistics.median(savings),'fasterPairs':sum(v>0 for v in savings),
        'candidateEligible':False,'actualCrossQuestionRemoteReuse':False,'candidateImprovementDemonstrated':False,
        'chosen':'persistent','selectionGate':'Speed conditions alone are insufficient; actual cross-question remote reuse is a mandatory gate.',
        'secretScan':read('development.json')['secretScan']})
    print(json.dumps({'counts':counts,'correct':48,'candidateEligible':False,'chosen':'persistent',
        'pairedMedianSaving':statistics.median(savings),'fasterPairs':sum(v>0 for v in savings)}))
