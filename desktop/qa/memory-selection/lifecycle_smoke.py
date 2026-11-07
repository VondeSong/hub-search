"""Pre-formal real-boundary canary; preserved separately from acceptance."""
from lifecycle_support import *
from lifecycle_native import Native,collect_receipt
from lifecycle_bm import BM,corpus,body,observe,config

def main():
    assert max(len(r['content']) for r in corpus())<20000
    save(REPORTS/'native-harness-v2.json',collect_receipt())
    save(REPORTS/'preflight-v2-method.json',{'at':now(),'nativeDriver':digest(ROOT/'qa/memory-selection/lifecycle_native.py'),
       'rustSource':digest(ROOT/'src-tauri/src/agent_work/memory_lifecycle_tests.rs'),'scope':'native one note actual write/read/query/delete; BM isolated single note write/read/delete/retry; before formal freeze'})
    result={'at':now(),'status':'running'};c=None
    try:
        c=Native(WORK/'native-preflight-v2');r=corpus()[0]
        result['write']=c.write(r['id'],r['content'])
        result['visibility']=observe(c,{r['id']:r['content']},c.last_ack)
        assert result['visibility']['ready']
        result['readback']=c.readback(r['id'],r['content']);assert result['readback']
        result['search']=c.search(r['content'][:230],lexical='HBMOP000S00V0')
        assert r['id'] in result['search']['lexicalIds'] and r['id'] in result['search']['vectorIds']
        result['delete']=c.delete(r['id']);assert observe(c,{},c.last_ack)['ready']
        assert c.search(r['content'][:230],lexical='HBMOP000S00V0')=={'vectorIds':[],'lexicalIds':[]}
        result['nativeResidual']=c.close();c=None
        state=WORK/'bm-preflight-v2';state.mkdir(exist_ok=False)
        for project in ['left','right']:(state/'notes'/project).mkdir(parents=True)
        config(state,32);c=BM(state)
        c.write('hbm-op-999',body(999));assert observe(c,{'hbm-op-999':body(999)},c.last_ack)['ready']
        result['bmReadback']=c.readback('hbm-op-999',body(999));assert result['bmReadback']
        c.delete('hbm-op-999');assert observe(c,{},c.last_ack)['ready']
        result['bmRepeatedDelete']=c.delete('hbm-op-999');assert observe(c,{},c.last_ack)['ready']
        result['status']='completed'
    except BaseException as e:
        result.update(status='failed',errorType=type(e).__name__,error=str(e));raise
    finally:
        try:
            if c:result['residual']=c.close()
        finally:save(REPORTS/'preflight-v2-result.json',result)
    print({'status':result['status'],'nativeVisibility':result['visibility'],'bmReadback':result['bmReadback']})
if __name__=='__main__':main()
