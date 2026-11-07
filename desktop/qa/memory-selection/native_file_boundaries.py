"""Offline file-boundary attribution, with same-thread containment and no nested sums."""
from pathlib import Path
import json,statistics
ROOT=Path(__file__).resolve().parents[2]
R=ROOT/'artifacts/hbm-00-native-file-20261019'
LEAVES={'file-create-new','file-created-flush','file-write','file-terminate-flush','file-sync-data',
        'atomic-temp-create','atomic-write-all','atomic-flush','atomic-sync-data','atomic-persist','managed-lock-wait'}
def stats(xs):return {'n':len(xs),'median':statistics.median(xs),'max':max(xs),'sum':sum(xs)} if xs else None
def union_ns(intervals):
 end=None;total=0
 for lo,hi in sorted(intervals):
  total+=max(0,hi-max(lo,end if end is not None else lo));end=max(hi,end or hi)
 return total
def main():
 a=json.loads((R/'analysis.json').read_text());raw=json.loads((R/'events-on.json').read_text());events=a['events']
 for e in events:e['file']=raw['files'][e['file_id']-1] if e['file_id'] else None
 relevant=[e for e in events if e['operation'] and e['phase'] in LEAVES]
 groups={}
 for phase in sorted(LEAVES):
  es=[e for e in relevant if e['phase']==phase]
  groups[phase]={'calls':stats([e['ms'] for e in es]),'byKind':{}}
  for kind in sorted({e['file'] if e['file'] in ['.managed.json','meta.json'] else Path(e['file'] or '').suffix for e in es}):
   matching=[e for e in es if (e['file'] if e['file'] in ['.managed.json','meta.json'] else Path(e['file'] or '').suffix)==kind]
   groups[phase]['byKind'][kind]=stats([e['ms'] for e in matching])
 critical=[]
 for op in range(1,13):
  w=max((e for e in events if e['operation']==op and e['phase']=='worker-index-documents'),key=lambda e:e['end_ns'])
  prepare=next(e for e in events if e['operation']==op and e['phase']=='commit-prepare-workers')
  row={'operation':op,'workerTid':w['tid'],'workerMs':w['ms'],'prepareMs':prepare['ms'],'prepareAfterWorkerMs':(prepare['end_ns']-w['end_ns'])/1e6,'sections':{}}
  for ph in ['worker-create-writer','worker-finalize','finalize-serializer-close']:
   p=next(e for e in events if e['phase']==ph and e['tid']==w['tid'] and w['start_ns']<=e['start_ns']<=e['end_ns']<=w['end_ns'])
   es=[e for e in relevant if e['tid']==p['tid'] and p['start_ns']<=e['start_ns']<=e['end_ns']<=p['end_ns']]
   leaves={phase:sum(e['ms'] for e in es if e['phase']==phase) for phase in sorted(LEAVES)}
   row['sections'][ph]={'ms':p['ms'],'cpuMs':p['cpuMs'],'leafMs':leaves,'unassignedMs':p['ms']-sum(leaves.values())}
  critical.append(row)
 section_summary={ph:{'wallMs':stats([r['sections'][ph]['ms'] for r in critical]),'leaves':{leaf:stats([r['sections'][ph]['leafMs'][leaf] for r in critical]) for leaf in sorted(LEAVES)}} for ph in critical[0]['sections']}
 lock_overlaps=[]
 for lock in [e for e in relevant if e['phase']=='managed-lock-wait']:
  ranges=[(max(lock['start_ns'],e['start_ns']),min(lock['end_ns'],e['end_ns'])) for e in events if e['phase']=='atomic-total' and e['file']=='.managed.json' and e['tid']!=lock['tid'] and e['start_ns']<lock['end_ns'] and e['end_ns']>lock['start_ns']]
  lock_overlaps.append({'operation':lock['operation'],'tid':lock['tid'],'waitMs':lock['ms'],'otherThreadManagedAtomicOverlapMs':union_ns(ranges)/1e6})
 out={'scope':'Same-thread containment for critical worker. Leaf sums exclude parent spans; cross-thread time is never added to wall time. Requested bytes are not disk I/O.',
      'groups':groups,'criticalWorkers':critical,'criticalSummary':section_summary,'lockOverlaps':lock_overlaps,
      'slowestPrepare':max(critical,key=lambda r:r['prepareMs']),
      'largestLeafCalls':sorted(relevant,key=lambda e:e['ms'],reverse=True)[:20]}
 (R/'file-boundary-analysis.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
 print(json.dumps({'criticalSummary':section_summary,'slowestPrepare':out['slowestPrepare']},indent=2))
if __name__=='__main__':main()
