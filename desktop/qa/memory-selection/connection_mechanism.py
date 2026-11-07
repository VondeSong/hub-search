"""Describe reconnect/prewarm movement from existing logs; zero new model calls."""
from datetime import datetime
import json
from pathlib import Path
import statistics
from connection_support import WORK,read,save

if __name__=='__main__':
    dev=read('development-audit.json')
    rows=dev['results']; events=read('development-raw.json')['events']
    stamp=lambda e:round(datetime.fromisoformat(e['event.timestamp'].replace('Z','+00:00')).timestamp()*1e9)
    reset_id=next(r['receipt']['threadId'] for r in rows if r['mode']=='reset')
    reset_connects=[e for e in events if e['event.name']=='codex.websocket_connect' and e['conversation.id']==reset_id]
    reset_rows=[r for r in rows if r['mode']=='reset']
    categories={'first':[],'after_other_mode':[],'immediately_after_reset':[]}
    detailed=[]
    previous_reset=None
    for i,row in enumerate(rows):
        if row['mode']!='reset':
            continue
        kind='first' if previous_reset is None else 'immediately_after_reset' if rows[i-1]['mode']=='reset' else 'after_other_mode'
        interval_ms=(row['startUnixNs']-previous_reset['endUnixNs'])/1e6 if previous_reset else None
        before=[e for e in reset_connects if previous_reset and previous_reset['endUnixNs']<=stamp(e)<=row['startUnixNs']]
        categories[kind].append(row['callMs'])
        detailed.append({'round':row['round'],'case':row['caseNumber'],'kind':kind,'idleSincePreviousResetMs':interval_ms,
            'callMs':row['callMs'],'resetConnectionsCompletedDuringIdle':len(before),
            'nativeRequestEventsWithinCall':sum(e['event.name']=='codex.websocket_request' for e in row['remoteEvents'])})
        previous_reset=row
    last_end=reset_rows[-1]['endUnixNs']
    after_last=[e for e in reset_connects if stamp(e)>last_end]
    equivalence=[]
    for ident in read('development-contract.json')['cases']:
        rr=[r for r in rows if r['id']==ident]
        equivalence.append({'id':ident,'sameInputHash':len({r['promptSha256'] for r in rr})==1,
            'inputTokens':[r['receipt']['usage']['inputTokens'] for r in rr],
            'cachedTokens':[r['receipt']['usage']['cachedInputTokens'] for r in rr]})
    normal=read('continuity-no-reset.json')['connectionEvents']
    save('mechanism.json',{'modelCalls':0,'normalContinuity':{'turns':2,'newConnections':sum(e['event.name']=='codex.websocket_connect' for e in normal),
        'memoryStrategyEligible':False,'reason':'Ordinary conversation retains preceding question history.'},
        'resetCandidate':{'turns':24,'newConnections':len(reset_connects),'connectsOutsideOwnCallWindows':len(dev['resetConnectEventsOutsideOwnCallWindow']),
            'connectsOverlappingBaselineWindows':sum(bool(e['overlappingBaselineCases']) for e in dev['resetConnectEventsOutsideOwnCallWindow']),
            'connectionsAfterFinalCall':after_last,'cases':detailed,
            'byPrecedingMode':{k:{'n':len(v),'medianMs':statistics.median(v) if v else None} for k,v in categories.items()}},
        'sourceEquivalence':equivalence,'sameHomeCwdAndProcess':True,
        'interpretation':'Native history reset triggers fresh connection/prewarm, sometimes while the other mode is running. Connection work moved outside the candidate call boundary; lower observed wait does not establish lower total latency or connection reuse. No post-hoc timing correction is substituted for the original measurements.',
        'limits':'Observational grouping of the frozen crossover, not randomized identification of each transport subphase. Remote load and prefix caching remain uncontrolled.'})
    print(json.dumps({'resetConnections':len(reset_connects),'outsideCall':len(dev['resetConnectEventsOutsideOwnCallWindow']),
        'overlappingBaseline':sum(bool(e['overlappingBaselineCases']) for e in dev['resetConnectEventsOutsideOwnCallWindow']),
        'afterLast':len(after_last),'byPrecedingMode':{k:{'n':len(v),'medianMs':statistics.median(v) if v else None} for k,v in categories.items()}}))
