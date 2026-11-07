"""One bounded split-timing probe; frozen binary and original failure retained."""
from native_recovery import *

REPORT=ROOT/'artifacts/hbm-00-native-stage-diag-20261019'
SOURCE=AREA/'soak-v3/state'
STATE=AREA/'stage-diag-20261019'
V2=ROOT/'artifacts/hbm-00-native-soak-v2-20261019'

def main():
    receipt=read(REPORT/'native-harness-v2.json');assert digest(receipt['executable'])==receipt['binarySha256']
    native.REPORTS=REPORT
    os.environ['HBM_STAGE_DIAG']='1'
    before={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
    save(REPORT/'original-manifest.json',before)
    shutil.copytree(SOURCE,STATE)
    expected={r['id']:r['content'] for r in corpus()}
    for cycle in range(663):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    client=None;result={'at':now(),'rows':[]};began=time.perf_counter()
    try:
        client=start(STATE);assert matches(client.snapshot(),expected)
        for number,revision in [[2,664],[3,664],[2,665],[4,664],[2,666],[5,664]]:
            mid=f'hbm-op-{number:03}';content=body(number,revision)
            for retry in [False,True]:
                assert time.perf_counter()-began<240
                request_at=time.time()
                ack=client.write(mid,content);expected[mid]=content
                completion=client.receive();assert completion['ok'];client.pending=False
                done=time.perf_counter();snapshot=client.snapshot();read_at=time.perf_counter()
                valid=matches(snapshot,expected);matched_at=time.perf_counter()
                found=lookup(client,mid,content,revision=revision);queried=time.perf_counter()
                row={'requestUnixMs':request_at*1000,'endUnixMs':time.time()*1000,'id':mid,'revision':revision,'retry':retry,'ack':ack,'serverFullMs':completion['fullMs'],
                     'serverPostAckMs':completion['fullMs']-ack['serverAckMs'],'clientCompletionWaitMs':(done-client.last_ack)*1000,
                     'stateReadMs':(read_at-done)*1000,'stateMatchMs':(matched_at-read_at)*1000,'queryMs':(queried-matched_at)*1000,
                     'totalPostAckMs':(queried-client.last_ack)*1000,'wholeStateMatches':valid,'queryFound':found}
                row['withinOriginal5s']=row['totalPostAckMs']<=5000 and valid and found
                result['rows'].append(row);save(REPORT/f"step-{len(result['rows']):02}.json",row)
                print(json.dumps(row),flush=True)
                if not valid or not found:raise RuntimeError('State/query correctness failed')
        result['status']='completed'
    except BaseException as e:result.update(status='failed',error=str(e))
    finally:
        result['residual']=client.close() if client else []
        result['originalUnchanged']=before=={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
        os.environ.pop('HBM_STAGE_DIAG',None)
        result['wallMs']=(time.perf_counter()-began)*1000;save(REPORT/'result.json',result)

if __name__=='__main__':main()
