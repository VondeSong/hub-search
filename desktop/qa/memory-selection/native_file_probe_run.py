"""Frozen off/on same-binary comparison. Consumed identities must never be rerun."""
from native_recovery import *
import queue
REPORT=ROOT/'artifacts/hbm-00-native-file-20261019'
SOURCE=AREA/'soak-v3/state'
BASE=AREA/'file-probe'

def main():
    receipt=read(REPORT/'native-harness-v2.json')
    assert digest(receipt['executable'])==receipt['binarySha256']
    with (REPORT/'run.started').open('x') as f:
        json.dump({'at':now(),'pid':os.getpid(),'createTime':psutil.Process().create_time(),'driverSha256':digest(__file__)},f)
    native.REPORTS=REPORT
    before={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
    save(REPORT/'original-manifest.json',before)
    prep=time.perf_counter()
    for arm in ['off','on']:shutil.copytree(SOURCE,BASE/arm)
    prep_ms=(time.perf_counter()-prep)*1000
    result={'at':now(),'copyMs':prep_ms,'arms':[]};client=None;began=time.perf_counter();deadline=began+360
    old_receive=native.Native.receive
    def bounded_receive(self):
        r=self.queue.get(timeout=max(.01,min(180,deadline-time.perf_counter())))
        if isinstance(r,Exception):raise r
        if r is None:raise RuntimeError('Native harness exited; inspect owned stderr')
        return r
    native.Native.receive=bounded_receive
    try:
        for arm in ['off','on']:
            expected={r['id']:r['content'] for r in corpus()}
            for cycle in range(663):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
            os.environ['HBM_WORKER_PROBE']='1' if arm=='on' else '0'
            os.environ['HBM_WORKER_REPORT']=str(REPORT/f'events-{arm}.json')
            started=time.perf_counter();client=start(BASE/arm)
            rowset={'arm':arm,'rows':[],'ownedAtStart':client.usage()['members']};result['arms'].append(rowset)
            assert matches(client.snapshot(),expected)
            for number,revision in [[2,664],[3,664],[2,665],[4,664],[2,666],[5,664]]:
                mid=f'hbm-op-{number:03}';content=body(number,revision)
                for retry in [False,True]:
                    assert time.perf_counter()<deadline,'Bounded workload budget exceeded'
                    request_at=time.time();ack=client.write(mid,content);expected[mid]=content
                    completion=client.receive();assert completion['ok'];client.pending=False
                    done=time.perf_counter();snapshot=client.snapshot();read_at=time.perf_counter()
                    valid=matches(snapshot,expected);matched_at=time.perf_counter()
                    found=lookup(client,mid,content,revision=revision);queried=time.perf_counter()
                    row={'requestUnixMs':request_at*1000,'endUnixMs':time.time()*1000,'id':mid,'revision':revision,'retry':retry,'ack':ack,
                         'serverPostAckMs':completion['fullMs']-ack['serverAckMs'],'clientCompletionWaitMs':(done-client.last_ack)*1000,
                         'stateReadMs':(read_at-done)*1000,'stateMatchMs':(matched_at-read_at)*1000,'queryMs':(queried-matched_at)*1000,
                         'totalPostAckMs':(queried-client.last_ack)*1000,'wholeStateMatches':valid,'queryFound':found}
                    row['withinOriginal5s']=row['totalPostAckMs']<=5000 and valid and found
                    rowset['rows'].append(row);save(REPORT/f"{arm}-step-{len(rowset['rows']):02}.json",row)
                    print(json.dumps({'arm':arm,'step':len(rowset['rows']),'ms':row['totalPostAckMs'],'passed':row['withinOriginal5s']}),flush=True)
                    if not valid or not found:raise RuntimeError('State/query correctness failed')
            rowset['residual']=client.close();client=None
            rowset['wallMs']=(time.perf_counter()-started)*1000
        result['status']='completed'
    except BaseException as e:result.update(status='failed',error=repr(e))
    finally:
        result['residual']=client.close() if client else []
        native.Native.receive=old_receive
        for k in ['HBM_WORKER_PROBE','HBM_WORKER_REPORT']:os.environ.pop(k,None)
        result['wallMs']=(time.perf_counter()-began)*1000
        result['originalUnchanged']=before=={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
        save(REPORT/'result.json',result)
if __name__=='__main__':main()
