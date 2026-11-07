"""Bounded paired ordering diagnosis; no product changes or gate substitution."""
from native_recovery import *
import statistics
REPORT=ROOT/'artifacts/hbm-00-native-tail-v3-20261019'
SOURCE=AREA/'soak-v3/state'
DEST=AREA/'tail-v3-diagnosis-20261019'
PREV=ROOT/'artifacts/hbm-00-native-soak-v3-20261019'

def main():
    REPORT.mkdir(exist_ok=False);DEST.mkdir(exist_ok=False)
    receipt=read(PREV/'native-harness-v2.json');assert digest(receipt['executable'])==receipt['binarySha256']
    save(REPORT/'contract.json',{'at':now(),'driverSha256':digest(__file__),'binarySha256':receipt['binarySha256'],
      'inputs':[[2,664],[3,664],[2,665]],'arms':['state-first','query-first'],'retryEach':True,'maxOperations':12,'budgetSeconds':240,
      'postAckLimitMs':5000,'hypotheses':{'auditOverhead':'Query-first exposes directly observed postACK lookup without removing full-state correctness checks.','persistentSlowState':'Same full final-state copies and same updates show whether the slow stages persist after restart.','cpuVersusWait':'Per-stage owned-process CPU deltas describe current run only; absent historical CPU/I/O cannot attribute historical scheduling or disk.'},
      'stop':'One paired run only. No performance tuning, production changes,24h restart or backend decision. Correctness failure stops run.',
      'limits':'Final-state copies, new processes and sequential arms cannot reproduce historical OS/cache conditions. Query-first changes cache ordering; cannot subtract timings to retroactively pass original failure. CPU sampling overhead included; no OS tracing.'})
    save(REPORT/'native-harness-v2.json',receipt);native.REPORTS=REPORT
    before={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()};save(REPORT/'source-manifest.json',before)
    for arm in ['state-first','query-first']:shutil.copytree(SOURCE,DEST/arm)
    baseline={r['id']:r['content'] for r in corpus()}
    for cycle in range(663):baseline[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    result={'at':now(),'rows':[]};client=None;began=time.perf_counter()
    try:
      for arm in ['state-first','query-first']:
        expected=dict(baseline);client=start(DEST/arm);assert matches(client.snapshot(),expected)
        members=client.usage()['members']
        def cpu():
          total=0.
          for m in members:
            proc=psutil.Process(m['pid']);assert abs(proc.create_time()-m['createTime'])<.01
            t=proc.cpu_times();total+=t.user+t.system
          return total*1000
        for number,revision in [[2,664],[3,664],[2,665]]:
          mid=f'hbm-op-{number:03}';content=body(number,revision)
          for retry in [False,True]:
            assert time.perf_counter()-began<240
            ack=client.write(mid,content);expected[mid]=content;c0=cpu()
            completion=client.receive();assert completion['ok'];client.pending=False;done=time.perf_counter();c1=cpu()
            row={'arm':arm,'id':mid,'revision':revision,'retry':retry,'ack':ack,'serverPostAckMs':completion['fullMs']-ack['serverAckMs'],'completionWaitMs':(done-client.last_ack)*1000,'completionCpuMs':c1-c0}
            for phase in (['state','query'] if arm=='state-first' else ['query','state']):
              cb=cpu();t=time.perf_counter()
              if phase=='state':
                snap=client.snapshot();returned=time.perf_counter();valid=matches(snap,expected);end=time.perf_counter()
                row.update(stateReadMs=(returned-t)*1000,stateMatchMs=(end-returned)*1000,wholeStateMatches=valid,notes=len(snap['notes']),chunks=len(snap['chunks']))
              else:
                found=lookup(client,mid,content,revision=revision);end=time.perf_counter();row.update(queryMs=(end-t)*1000,lookupAfterAckMs=(end-client.last_ack)*1000,queryFound=found)
              row[phase+'CpuMs']=cpu()-cb
            row.update(fullAuditAfterAckMs=(time.perf_counter()-client.last_ack)*1000)
            row['lookupWithin5s']=row['lookupAfterAckMs']<=5000 and found
            row['fullAuditWithin5s']=row['fullAuditAfterAckMs']<=5000 and valid and found
            result['rows'].append(row);save(REPORT/f"step-{len(result['rows']):02}.json",row);print(json.dumps(row),flush=True)
            assert valid and found
        assert not client.close();client=None
      result['status']='completed'
    except BaseException as e:result.update(status='failed',error=repr(e))
    finally:
      result['residual']=client.close() if client else []
      result['originalUnchanged']=before=={str(p.relative_to(SOURCE)):digest(p) for p in SOURCE.rglob('*') if p.is_file()}
      result['wallMs']=(time.perf_counter()-began)*1000;save(REPORT/'result.json',result)
if __name__=='__main__':main()
