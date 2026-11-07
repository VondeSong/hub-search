"""Single frozen workload with at most three user-mode thread snapshot batches."""
import hashlib,json,os,subprocess,sys,time
from pathlib import Path
import psutil
from native_wait_stack import Reader

ROOT=Path(__file__).resolve().parents[2]
REPORT=ROOT/'artifacts/hbm-00-native-commit-wait-20261019'
STATE=ROOT/'.local/hbm-00/lifecycle-20261018/recovery-20261019/commit-wait-20261019'

def main():
    receipt=json.loads((REPORT/'native-harness-v2.json').read_text())
    method={'at':time.time(),'reason':'WPR denied 0xc5585011 before any workload; user-mode fallback',
      'operations':12,'budgetSeconds':240,'gateMs':5000,'batchLimit':3,'threadsPerBatchMax':24,
      'trigger':'first three distinct active prepare/publish spans >=100ms; poll40ms; include all owned test threads up to24',
      'limits':'Thread suspension perturbs measurements. No system/kernel/ready-time trace; no independent reproduction control. Local PDB only. No workload repeat.',
      'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),Path(__file__).with_name('native_wait_stack.py'),Path(__file__).with_name('native_commit_wait_diagnosis.py')]}}
    with (REPORT/'user-capture-contract.json').open('x',encoding='utf-8') as f:json.dump(method,f,indent=2)
    reader=None;p=None;offset=0;active={};sampled=set();batches=[];errors=[]
    try:
        with (REPORT/'user-driver.stdout.log').open('xb') as out,(REPORT/'user-driver.stderr.log').open('xb') as err:
            p=subprocess.Popen([sys.executable,'-X','utf8',str(Path(__file__).with_name('native_commit_wait_diagnosis.py'))],cwd=ROOT,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
            while p.poll() is None:
                log=STATE/'native.stderr.log'
                if log.exists():
                    with log.open('rb') as f:f.seek(offset);lines=f.readlines();offset=f.tell()
                    for line in lines:
                        if not line.startswith(b'HBMDIAG '):continue
                        event=json.loads(line[8:]);key=(event['pid'],event['tid'],event['phase'])
                        if event['event']=='begin':active[key]=event
                        else:active.pop(key,None)
                    for key,event in list(active.items()):
                        identity=(*key,event['unixMs'])
                        if len(batches)>=3 or identity in sampled or event['phase'] not in ['commit-prepare-workers','commit-publish'] or time.time()*1000-event['unixMs']<100:continue
                        owned=next((q for q in psutil.Process(p.pid).children(recursive=True) if q.pid==event['pid'] and Path(q.exe()).resolve()==Path(receipt['executable']).resolve()),None)
                        if not owned:raise RuntimeError('Thread sampler ownership not verified')
                        if reader is None:reader=Reader(owned.pid,Path(receipt['sourceExecutable']).parent)
                        batch={'event':event,'createTime':owned.create_time(),'startedUnixMs':time.time()*1000,'threads':[]}
                        sampled.add(identity);batches.append(batch)
                        tids=[event['tid']]+[t.id for t in owned.threads() if t.id!=event['tid']]
                        for tid in tids[:24]:batch['threads'].append(reader.sample(tid))
                        batch['endedUnixMs']=time.time()*1000
                        (REPORT/'user-wait-stacks.json').write_text(json.dumps(batches,indent=2),encoding='utf-8')
                time.sleep(.04)
    except BaseException as exc:
        errors.append(repr(exc))
        # Do not interrupt or rerun the independently bounded driver for a sampler failure.
        if p:p.wait(timeout=330)
    finally:
        if reader:reader.close()
        result={'driverExitCode':p.returncode if p else None,'batches':len(batches),'errors':errors,'endedUnixMs':time.time()*1000}
        (REPORT/'user-capture-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result))

if __name__=='__main__':main()
