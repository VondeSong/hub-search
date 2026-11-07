"""Third soak: identical workload/binary with durable per-operation phase timing."""
import native_soak as soak
import native_soak_v2 as previous
from native_recovery import *

REPORT=ROOT/'artifacts/hbm-00-native-soak-v3-20261019'
STATE=AREA/'soak-v3'
JOURNAL=None
SEQUENCE=0

def event(op,phase,**fields):
    with JOURNAL.open('a',encoding='utf-8') as f:
        f.write(json.dumps({'operation':op,'phase':phase,'at':now(),'monotonic':time.perf_counter(),**fields},ensure_ascii=False)+'\n');f.flush()

def checked(client,mid,content,expected,revision=0,delete=False):
    global SEQUENCE
    SEQUENCE+=1;op=SEQUENCE
    event(op,'request',id=mid,revision=revision,kind='delete' if delete else 'write')
    receipt=client.delete(mid) if delete else client.write(mid,content)
    if delete:expected.pop(mid,None)
    else:expected[mid]=content
    event(op,'ack',ackMonotonic=client.last_ack,receipt=receipt)
    completion=client.receive();assert completion['ok'];client.pending=False
    completed=time.perf_counter()
    event(op,'index-complete',serverFullMs=completion['fullMs'],serverPostAckMs=completion['fullMs']-receipt['serverAckMs'],clientWaitMs=(completed-client.last_ack)*1000)
    reads=0.;comparisons=0.;polls=0;valid=False
    while time.perf_counter()-client.last_ack<60:
        event(op,'state-start');begin=time.perf_counter();snapshot=client.snapshot();returned=time.perf_counter()
        valid=matches(snapshot,expected);matched=time.perf_counter();polls+=1
        reads+=(returned-begin)*1000;comparisons+=(matched-returned)*1000
        event(op,'state-end',readMs=(returned-begin)*1000,matchMs=(matched-returned)*1000,matches=valid)
        if valid:break
        time.sleep(.1)
    ready_ms=(time.perf_counter()-client.last_ack)*1000
    event(op,'query-start');begin=time.perf_counter()
    found=lookup(client,mid,body(int(mid[-3:])) if delete else content,absent=delete,revision=revision)
    end=time.perf_counter();elapsed=(end-client.last_ack)*1000
    row={'operationId':op,'receipt':receipt,'ready':{'ready':valid,'elapsedMs':ready_ms,'within5s':valid and ready_ms<=5000,'polls':polls},
      'queryAfterAckMs':elapsed,'passed':valid and found and elapsed<=5000,
      'timing':{'serverPostAckMs':completion['fullMs']-receipt['serverAckMs'],'completionWaitMs':(completed-client.last_ack)*1000,
                'stateReadMs':reads,'stateMatchMs':comparisons,'queryMs':(end-begin)*1000},
      'absent' if delete else 'queryFound':found}
    event(op,'complete',result=row)
    return row

def write_checked_v3(client,mid,content,expected,revision=0):return checked(client,mid,content,expected,revision)
def delete_checked_v3(client,mid,expected):return checked(client,mid,'',expected,delete=True)

def register():
    receipt=previous.verify()
    assert read(previous.REPORT/'soak-result.json')['status']=='failed'
    assert not REPORT.exists() and not STATE.exists()
    REPORT.mkdir();STATE.mkdir()
    c=read(previous.REPORT/'soak-contract.json')
    c.update(at=now(),wrapperSha256=digest(__file__),priorFailedResultSha256=digest(previous.REPORT/'soak-result.json'),
      priorContractSha256=digest(previous.REPORT/'soak-contract.json'),
      instrumentation='Write/delete retain full-state matching and actual query within5s. Explicitly receive existing completion frame; journal each phase. Journal overhead betweenACK and query is included. IO/scheduler within each stage is not separately attributed.',
      preflight='Same binary and seed on separate copy: update, identical retry, delete, recreate; all4must pass before launching.',
      reason='User approved new24h with persistent split timing; no production change or relaxed limits.')
    save(REPORT/'soak-contract.json',c);save(REPORT/'native-harness-v2.json',receipt)

def prepare():
    c=read(REPORT/'soak-contract.json');previous.verify()
    assert digest(__file__)==c['wrapperSha256']
    assert c['seedFiles']=={str(p.relative_to(AREA/'seed')):digest(p) for p in (AREA/'seed').rglob('*') if p.is_file()}
    native.REPORTS=REPORT

def preflight():
    global JOURNAL
    prepare();JOURNAL=REPORT/'preflight-phases.jsonl';target=AREA/'soak-v3-preflight'
    shutil.copytree(AREA/'seed',target);client=None;result={'at':now(),'checks':[]}
    expected={r['id']:r['content'] for r in corpus()}
    try:
        client=start(target);assert matches(client.snapshot(),expected)
        for _ in range(2):result['checks'].append(write_checked_v3(client,'hbm-op-000',body(0,1),expected,1))
        result['checks'].append(delete_checked_v3(client,'hbm-op-060',expected))
        result['checks'].append(write_checked_v3(client,'hbm-op-060',body(60),expected))
        result['passed']=all(x['passed'] for x in result['checks'])
    except BaseException as e:result.update(passed=False,error=str(e))
    finally:
        result['residual']=client.close() if client else []
        if result['residual']:result['passed']=False
        save(REPORT/'preflight.json',result)
    print(json.dumps(result),flush=True)

def run():
    global JOURNAL
    prepare();assert read(REPORT/'preflight.json')['passed'];JOURNAL=STATE/'phases.jsonl'
    soak.OUT=REPORT;soak.SOAK=STATE;soak.PROGRESS=REPORT/'soak-progress.json'
    soak.write_checked=write_checked_v3;soak.delete_checked=delete_checked_v3
    soak.exercise()

if __name__=='__main__':
    import sys
    {'register':register,'preflight':preflight,'run':run}[sys.argv[1]]()
