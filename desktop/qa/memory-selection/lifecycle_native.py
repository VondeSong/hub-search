"""Controller for the uniquely collected, byte-verified real Hub Rust harness."""
import queue, threading
import psutil
from lifecycle_support import *
from lifecycle_bm import chunks

TEST='agent_work::memory_lifecycle_tests::native_lifecycle_rpc'
def collect_receipt():
    rows=[]
    for p in (ROOT/'.local/rust-test-runs').glob('*/receipt.json'):
        r=read(p)
        if r.get('status')=='collected' and r.get('collected')==1 and TEST in r.get('tests',[]):rows.append(r)
    r=max(rows,key=lambda r:r['finishedAt'])
    assert digest(r['executable'])==r['binarySha256'] and r['byteIdentical']
    assert digest(r['executable']+'.manifest')==r['manifestSha256']
    return r

class Native:
    def __init__(self,state):
        self.state=state;self.last_ack=None;self.queue=queue.Queue();self.pending=False
        r=read(REPORTS/'native-harness-v2.json');assert digest(r['executable'])==r['binarySha256']
        bundle=OLD/'rust-runtime/bundle'
        env=os.environ.copy();env.update(HBM_LIFECYCLE_ROOT=str(state),HBM_EMBED_EXE=str(bundle/'hbm00-native-runtime-probe.exe'),
           HBM_EMBED_MODEL=str(bundle),ORT_DYLIB_PATH=str(bundle/'onnxruntime.dll'),TEMP=str(WORK/'tmp'),TMP=str(WORK/'tmp'))
        state.mkdir(parents=True,exist_ok=True)
        self.log=(state/'native.stderr.log').open('ab')
        self.p=subprocess.Popen([r['executable'],TEST,'--exact','--ignored','--nocapture','--test-threads=1'],cwd=ROOT,env=env,
           stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,creationflags=FLAGS)
        self.created=psutil.Process(self.p.pid).create_time()
        threading.Thread(target=self._read,daemon=True).start()
        try:
            ready=self.receive();assert ready['event']=='ready'
            self.embedding_pid=ready['embeddingPid'];self.embedding_created=psutil.Process(self.embedding_pid).create_time()
        except BaseException:self.close();raise
    def _read(self):
        for raw in self.p.stdout:
            s=raw.decode('utf-8');at=s.find('HBMJSON ')
            if at>=0:
                try:self.queue.put(json.loads(s[at+8:]))
                except Exception as e:self.queue.put(e)
        self.queue.put(None)
    def receive(self):
        r=self.queue.get(timeout=180)
        if isinstance(r,Exception):raise r
        if r is None:raise RuntimeError('Native harness exited; inspect owned stderr')
        return r
    def call(self,q):
        if self.pending:
            r=self.receive();assert r['ok'];self.pending=False
        self.p.stdin.write((json.dumps(q,ensure_ascii=False)+'\n').encode());self.p.stdin.flush()
        return self.receive()
    def write(self,mid,body,project='left'):
        start=time.perf_counter();r=self.call({'op':'write','id':mid,'project':project,'body':body,'chunks':chunks(mid,body)})
        assert r['event']=='ack';self.last_ack=time.perf_counter();self.pending=True
        return {'ackMs':(self.last_ack-start)*1000,'serverAckMs':r['ackMs'],'embeddingMs':r['embeddingMs']}
    def delete(self,mid,project='left'):
        start=time.perf_counter();r=self.call({'op':'delete','id':mid,'project':project})
        assert r['event']=='ack';self.last_ack=time.perf_counter();self.pending=True
        return {'ackMs':(self.last_ack-start)*1000,'serverAckMs':r['ackMs']}
    def snapshot(self):
        r=self.call({'op':'state'});cs={}
        for x in r['chunks']:cs.setdefault(x['id'],[]).append(x['body'])
        notes={x['id']:x['body'] for x in r['notes']}
        return {'notes':notes,'chunks':cs,'ready':True,'orphans':sum(len(v) for k,v in cs.items() if k not in notes),
           'entityCount':len(r['notes']),'vectors':len(r['chunks'])}
    def readback(self,mid,body,project='left'):
        # State is produced using the real EvidenceReader, not a Python DB substitute.
        return self.snapshot()['notes'].get(mid,'').strip()==body.strip()
    def search(self,query,project='left',lexical=None):return self.call({'op':'search','query':query,'project':project,'lexical':lexical or query})
    def usage(self):
        members=[]
        try:
            p=psutil.Process(self.p.pid);processes=[p,*p.children(recursive=True)]
        except psutil.NoSuchProcess:processes=[]
        for child in processes:
            try:members.append({'pid':child.pid,'createTime':child.create_time(),'rssMiB':child.memory_info().rss/1024**2})
            except psutil.NoSuchProcess:pass
        return {'members':members,'rssMiB':sum(x['rssMiB'] for x in members)}
    def close(self):
        owned=self.usage()['members']
        if hasattr(self,'embedding_pid') and not any(m['pid']==self.embedding_pid for m in owned):
            owned.append({'pid':self.embedding_pid,'createTime':self.embedding_created})
        if self.p.poll() is None:
            try:self.call({'op':'close'});self.p.stdin.close();self.p.wait(timeout=20)
            except Exception:
                if self.p.poll() is None:self.p.terminate()
                self.p.wait(timeout=10)
        residual=[]
        for m in owned:
            try:
                p=psutil.Process(m['pid'])
                if abs(p.create_time()-m['createTime'])<.01:
                    p.wait(timeout=3)
            except psutil.NoSuchProcess:continue
            except psutil.TimeoutExpired:
                p.terminate();p.wait(timeout=5);residual.append(m['pid'])
        self.log.close()
        save(self.state/f'closed-{time.time_ns()}.json',{'at':now(),'owned':owned,'residualBeforeCleanup':residual,'exitCode':self.p.returncode})
        return residual
