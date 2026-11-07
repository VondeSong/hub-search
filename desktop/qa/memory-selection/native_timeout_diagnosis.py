"""One bounded split-timing probe; frozen binary and original failure retained."""
from native_recovery import *

REPORT=ROOT/'artifacts/hbm-00-native-timeout-20261019'
SOURCE=AREA/'soak-v2/state'
STATE=AREA/'timeout-diagnosis-20261019'
V2=ROOT/'artifacts/hbm-00-native-soak-v2-20261019'

def main():
    REPORT.mkdir(exist_ok=False)
    receipt=read(V2/'native-harness-v2.json')
    assert digest(receipt['executable'])==receipt['binarySha256']
    save(REPORT/'contract.json',{'at':now(),'driverSha256':digest(__file__),'binarySha256':receipt['binarySha256'],
      'scope':'One unchanged full failed-state copy; six predetermined updates plus identical retries; no quality changes or24h restart',
      'inputs':[[1,143],[2,143],[1,144],[3,144],[1,145],[4,145]],'postAckLimitMs':5000,'budgetSeconds':180,
      'timing':'Explicitly receive queued completion before state request; record server fullMs-ackMs, client completion wait, state response, match verification, query, total postACK; same data and original binary.',
      'limits':'Final state is after failed cycle, not a snapshot before the historical slow operation. New fast timings cannot attribute or erase historical timeout.'})
    save(REPORT/'native-harness-v2.json',receipt);native.REPORTS=REPORT
    before={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
    save(REPORT/'original-manifest.json',before)
    shutil.copytree(SOURCE,STATE)
    expected={r['id']:r['content'] for r in corpus()}
    for cycle in range(142):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    client=None;result={'at':now(),'rows':[]};began=time.perf_counter()
    try:
        client=start(STATE);assert matches(client.snapshot(),expected)
        for number,revision in [[1,143],[2,143],[1,144],[3,144],[1,145],[4,145]]:
            mid=f'hbm-op-{number:03}';content=body(number,revision)
            for retry in [False,True]:
                assert time.perf_counter()-began<180
                ack=client.write(mid,content);expected[mid]=content
                completion=client.receive();assert completion['ok'];client.pending=False
                done=time.perf_counter();snapshot=client.snapshot();read_at=time.perf_counter()
                valid=matches(snapshot,expected);matched_at=time.perf_counter()
                found=lookup(client,mid,content,revision=revision);queried=time.perf_counter()
                row={'id':mid,'revision':revision,'retry':retry,'ack':ack,'serverFullMs':completion['fullMs'],
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
        result['wallMs']=(time.perf_counter()-began)*1000;save(REPORT/'result.json',result)

if __name__=='__main__':main()
