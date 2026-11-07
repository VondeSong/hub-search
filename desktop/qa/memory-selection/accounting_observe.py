"""Supplemental bounded owned-process resource observation, not a 24h soak."""
from datetime import datetime,timezone
import json
import time
import psutil
from accounting_support import WORK,save

start=time.perf_counter(); samples=[]
while time.perf_counter()-start<3600:
    members=[]; seen=set()
    for path in [WORK/'validation-index/bm/process.json',WORK/'validation-server/process.json']:
        if not path.exists(): continue
        reg=json.loads(path.read_text(encoding='utf-8'))
        try:
            parent=psutil.Process(reg['pid'])
            if abs(parent.create_time()-reg['createTime'])>.01: continue
            for process in [parent]+parent.children(recursive=True):
                if process.pid in seen: continue
                seen.add(process.pid)
                try:
                    cpu=process.cpu_times()
                    members.append({'owner':path.parent.name,'pid':process.pid,'createTime':process.create_time(),
                                    'rssMiB':process.memory_info().rss/1024**2,'cpuSeconds':cpu.user+cpu.system})
                except (psutil.NoSuchProcess,psutil.AccessDenied): pass
        except (psutil.NoSuchProcess,psutil.AccessDenied): pass
    samples.append({'at':datetime.now(timezone.utc).isoformat(),'elapsedMs':(time.perf_counter()-start)*1000,
                    'members':members,'rssMiB':sum(p['rssMiB'] for p in members)})
    if (WORK.parent.parent.parent/'artifacts/hbm-00-accounting-20261018/evaluation.json').exists(): break
    # Stop by owned final artifact rather than touching the actor or its sockets.
    from accounting_support import REPORTS
    if (REPORTS/'evaluation.json').exists(): break
    time.sleep(10)
save('supplemental-resource-observation.json',{'samples':samples,'elapsedMs':(time.perf_counter()-start)*1000,
 'maxObservedRssMiB':max(s['rssMiB'] for s in samples),'maxOwnedProcessCount':max(len(s['members']) for s in samples),
 'intervalSeconds':10,'startedAfterIndexPreparationBegan':True,'completeColdStartPeakObserved':False,
 'meaning':'Supplemental passive owned-process observation during variable retrieval/model workload. Not the preregistered fixed-load 24-hour soak; no latency effectiveness claim.'})
print(json.dumps({'samples':len(samples),'maxObservedRssMiB':max(s['rssMiB'] for s in samples)}))
