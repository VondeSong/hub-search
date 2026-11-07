"""Offline analysis only; never launches or modifies the tested workload."""
import collections,json,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'artifacts/hbm-00-native-commit-wait-20261019'
STATE=ROOT/'.local/hbm-00/lifecycle-20261018/recovery-20261019/commit-wait-20261019'

def main():
    result=json.loads((REPORT/'result.json').read_text());rows=result['rows']
    stacks=json.loads((REPORT/'user-wait-stacks.json').read_text());active={};spans=[]
    for line in (STATE/'native.stderr.log').read_text().splitlines():
        if not line.startswith('HBMDIAG '):continue
        e=json.loads(line[8:]);key=e['pid'],e['tid'],e['phase']
        if e['event']=='begin':assert key not in active;active[key]=e;continue
        b=active.pop(key);op=next((i+1 for i,r in enumerate(rows) if r['requestUnixMs']<=b['unixMs'] and e['unixMs']<=r['endUnixMs']),None)
        spans.append(dict(phase=e['phase'],pid=e['pid'],tid=e['tid'],beginUnixMs=b['unixMs'],endUnixMs=e['unixMs'],wallMs=e['elapsedMs'],operation=op,
          **{k:e['counters'][k]-b['counters'][k] for k in ['cpuMs','readOps','writeOps','readBytes','writeBytes','otherOps','otherBytes']}))
    assert not active
    affected=set()
    for b in stacks:
        affected.update(i+1 for i,r in enumerate(rows) if b['startedUnixMs']<=r['endUnixMs'] and b['endedUnixMs']>=r['requestUnixMs'])
        for t in b['threads']:
            t['observedPhase']=next((s['phase'] for s in spans if s['phase'] in ['commit-prepare-workers','commit-publish'] and s['beginUnixMs']<=t['unixMs']<=s['endUnixMs']),None)
    groups={}
    for label,predicate in [('all12',lambda s:s['operation'] is not None),('outsideSamplingBatches',lambda s:s['operation'] is not None and s['operation'] not in affected)]:
        groups[label]={}
        for phase in sorted({s['phase'] for s in spans}):
            subset=[s for s in spans if s['phase']==phase and predicate(s)]
            if subset:groups[label][phase]={'n':len(subset),**{k:{'median':statistics.median(s[k] for s in subset),'max':max(s[k] for s in subset)} for k in ['wallMs','cpuMs','readBytes','writeBytes']}}
    output={'operations':len(rows),'correct':sum(r['wholeStateMatches'] and r['queryFound'] for r in rows),
      'withinOriginal5s':sum(r['withinOriginal5s'] for r in rows),'maxTotalPostAckMs':max(r['totalPostAckMs'] for r in rows),
      'sampleAffectedOperations':sorted(affected),'outsideSamplingMaxPostAckMs':max(r['totalPostAckMs'] for i,r in enumerate(rows,1) if i not in affected),
      'wallMs':result['wallMs'],'originalUnchanged':result['originalUnchanged'],'residual':result['residual'],
      'threadSnapshots':sum(len(b['threads']) for b in stacks),'threadSnapshotErrors':sum('error' in t for b in stacks for t in b['threads']),
      'suspensionTotalMs':sum(t.get('pauseMs',0) for b in stacks for t in b['threads']),
      'groups':groups,'spans':spans,'stackBatches':stacks}
    (REPORT/'split-analysis.json').write_text(json.dumps(output,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({k:v for k,v in output.items() if k not in ['spans','stackBatches']},indent=2))

if __name__=='__main__':main()
