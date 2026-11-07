"""Offline summary of the frozen worker probe; does not rerun any operation."""
from pathlib import Path
import json,statistics
ROOT=Path(__file__).resolve().parents[2]
R=ROOT/'artifacts/hbm-00-native-file-20261019'
def summary(values):return {'n':len(values),'median':statistics.median(values),'max':max(values),'min':min(values)} if values else None
def main():
 result=json.loads((R/'result.json').read_text());arms={a['arm']:a for a in result['arms']}
 a=json.loads((R/'events-on.json').read_text());off=json.loads((R/'events-off.json').read_text())
 assert not off['enabled'] and not off['events'] and a['enabled']
 events=[]
 for e in a['events']:
  start=a['unixAnchorMs']+e['start_ns']/1e6;end=a['unixAnchorMs']+e['end_ns']/1e6
  op=next((i for i,r in enumerate(arms['on']['rows'],1) if r['requestUnixMs']<=start and end<=r['endUnixMs']),None)
  events.append(dict(e,startUnixMs=start,endUnixMs=end,ms=(e['end_ns']-e['start_ns'])/1e6,cpuMs=e['cpu_ns']/1e6 if e['cpu_ns']!=2**64-1 else None,operation=op))
 phases={}
 for phase in sorted({e['phase'] for e in events}):
  es=[e for e in events if e['phase']==phase and e['operation'] is not None]
  if es:phases[phase]={'wallMs':summary([e['ms'] for e in es]),'threadCpuMs':summary([e['cpuMs'] for e in es if e['cpuMs'] is not None])}
 totals={arm:{'correct':sum(r['wholeStateMatches'] and r['queryFound'] for r in data['rows']),'withinOriginal5s':sum(r['withinOriginal5s'] for r in data['rows']),
        'totalPostAckMs':summary([r['totalPostAckMs'] for r in data['rows']]),'indexWaitMs':summary([r['serverPostAckMs'] for r in data['rows']]),'wallMs':data['wallMs'],'residual':data['residual']} for arm,data in arms.items()}
 delta=(totals['on']['totalPostAckMs']['median']/totals['off']['totalPostAckMs']['median']-1)*100
 joins=[]
 for j in [e for e in events if e['phase']=='prepare-one-worker-join' and e['operation']]:
  overlapping=[]
  for e in events:
   if e['tid']==j['tid'] or e['operation']!=j['operation']:continue
   overlap=max(0,min(e['end_ns'],j['end_ns'])-max(e['start_ns'],j['start_ns']))/1e6
   if overlap:overlapping.append({'phase':e['phase'],'tid':e['tid'],'overlapMs':overlap,'phaseMs':e['ms']})
  joins.append({'operation':j['operation'],'joinMs':j['ms'],'overlappingSpans':overlapping})
 output={'status':result['status'],'totals':totals,'enabledMedianDeltaPct':delta,'overheadScreenPassed':delta<=10 and a['lost']==0,
 'overheadLimit':'Off then on nonrandom; screen not proof zero overhead; callbackCost excludes starts/dump and timings may alter scheduling',
 'eventCount':len(a['events']),'lost':a['lost'],'endRecordCostMs':a['recordCostNs']/1e6,'maxEndRecordCostMs':a['maxRecordCostNs']/1e6,
 'copyMs':result['copyMs'],'wallMs':result['wallMs'],'originalUnchanged':result['originalUnchanged'],'residual':result['residual'],'phases':phases,'joins':joins,'events':events}
 (R/'analysis.json').write_text(json.dumps(output,indent=2,ensure_ascii=False),encoding='utf-8')
 print(json.dumps({k:v for k,v in output.items() if k not in ['events','joins']},indent=2))
if __name__=='__main__':main()
