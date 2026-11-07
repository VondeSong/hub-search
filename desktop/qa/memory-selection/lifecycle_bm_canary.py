"""Verify explicit stable identity for new BM notes before formal acceptance."""
from lifecycle_support import *
from lifecycle_bm import BM,body,observe,config
def main():
    save(REPORTS/'bm-identity-canary-method.json',{'at':now(),'sourceSha256':digest(ROOT/'qa/memory-selection/lifecycle_bm.py'),'scope':'one new synthetic note create/update/read/delete/retry; no corpus or performance threshold changes'})
    result={'at':now(),'status':'running'};c=None
    try:
        state=WORK/'bm-identity-canary';state.mkdir(exist_ok=False)
        for p in ['left','right']:(state/'notes'/p).mkdir(parents=True)
        config(state,32);c=BM(state)
        result['writes']=[]
        for rev in [0,1]:
            receipt=c.write('hbm-op-999',body(999,rev));visibility=observe(c,{'hbm-op-999':body(999,rev)},c.last_ack)
            result['writes'].append({**receipt,'visibility':visibility});assert visibility['ready']
            assert c.readback('hbm-op-999',body(999,rev))
        c.delete('hbm-op-999');assert observe(c,{},c.last_ack)['ready']
        result['repeatDelete']=c.delete('hbm-op-999');assert observe(c,{},c.last_ack)['ready']
        result['status']='completed'
    except BaseException as e:result.update(status='failed',errorType=type(e).__name__,error=str(e));raise
    finally:
        try:
            if c:result['residual']=c.close()
        finally:save(REPORTS/'bm-identity-canary-result.json',result)
    print({'status':result['status'],'postAckMs':[r['visibility']['elapsedMs'] for r in result['writes']]})
if __name__=='__main__':main()
