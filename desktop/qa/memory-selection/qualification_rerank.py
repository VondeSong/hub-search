"""One bounded same-input optimization trial: reduce padded model work only."""
import json
import time
from pathlib import Path

from qualification_contract import *
from qualification_profile import old_index, profiled_resolve
from grounding_score import stats
import grounding_index as old

class LengthBuckets:
    def __init__(self, original):
        self.original=original
        self.work=None

    def rerank(self,query,documents,batch_size=8):
        docs=list(documents)
        enc=self.original.model.tokenizer.encode_batch([(query,d) for d in docs])
        lengths=[sum(e.attention_mask) for e in enc]
        order=sorted(range(len(docs)),key=lambda i:(lengths[i],i))
        def work(ids):
            padded=attention=0
            for start in range(0,len(ids),batch_size):
                group=ids[start:start+batch_size];longest=max(lengths[i] for i in group)
                padded+=len(group)*longest;attention+=len(group)*longest*longest
            return {'paddedTokenSlots':padded,'attentionSlotSquared':attention,'pairs':len(ids)}
        self.work={'original':work(list(range(len(docs)))),'bucketed':work(order)}
        values=list(self.original.rerank(query,[docs[i] for i in order],batch_size=batch_size))
        output=[None]*len(order)
        for i,value in zip(order,values,strict=True):output[i]=value
        return iter(output)

def main():
    before=read('profile-before.json');scope=read('scope-contract.json')
    save('optimization-contract.json',{'at':now(),'beforeProfileSha256':digest(REPORTS/'profile-before.json'),
        'sourceSha256':digest(__file__),'rootCause':'Cross encoder dominates local resolver, not query/file I/O',
        'hypothesis':'Same exact pairs sorted by token length reduce per-batch padding; no pair/content/weight/truncation/thread reduction',
        'sameInputs':scope['profile']['sameInputIds'],'n':20,'pairedOrder':'Alternate original/bucketed per question, one resident model, no resolution cache',
        'acceptOptimization':'Median paired wall saving>=20%,P95 no worse, ALL20 full ranked order AND evidence byte-equivalent. Otherwise reject equivalence and retain previous algorithm.',
        'productTarget':'Hot complete local retrieval P95<=1s, resolverP95<=500ms; may remain FAILED even if this relative experiment improves',
        'baselineCaveat':'Stage baseline had8s concurrent offline token-packing probe. THIS paired run starts only after that probe exits; no concurrent QA/model jobs.',
        'calls':0,'oneTrialOnly':True,'newMaterialsRead':False})
    idx=old_index()
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    began=time.perf_counter()
    original=TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8',threads=2,
        cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True)
    init_ms=(time.perf_counter()-began)*1000
    wrapper=LengthBuckets(original)
    cases={q['id']:q for q in read('validation.json',OLD)['cases']}
    rows={r['id']:r for r in read('evaluation.json',OLD)['rows'] if r['backend']=='hub-native-hybrid'}
    pairs=[];all_start=time.perf_counter()
    for i,qid in enumerate(scope['profile']['sameInputIds']):
        prior=rows[qid]['retrieval'];order=old.base.fuse(prior['vectorPassages'],prior['lexicalPassages'])
        outputs={}
        for mode in (['original','bucketed'] if i%2==0 else ['bucketed','original']):
            idx.reranker=original if mode=='original' else wrapper
            outputs[mode]=profiled_resolve(idx,cases[qid]['query'],prior['preRerank'],order)
        a,b=outputs['original'],outputs['bucketed']
        pair={'id':qid,'originalMs':a['totalMs'],'bucketedMs':b['totalMs'],
            'sameWholeRank':a['reranked']==b['reranked'],'sameTop5':a['reranked'][:5]==b['reranked'][:5],
            'sameEvidence':a['candidates']==b['candidates'],'originalEqualsPrior':a['candidates']==prior['candidates'],
            'directWork':wrapper.work,'savingFraction':1-b['totalMs']/a['totalMs']}
        assert pair['originalEqualsPrior']
        save(f'paired-performance-{i+1:02}.json',pair);pairs.append(pair)
        print(json.dumps({'pairedCompleted':i+1,'n':20,'originalMs':round(a['totalMs']),
            'bucketedMs':round(b['totalMs']),'rankEqual':pair['sameWholeRank'],'evidenceEqual':pair['sameEvidence']}),flush=True)
    originals=stats([x['originalMs'] for x in pairs]);optimized=stats([x['bucketedMs'] for x in pairs]);saving=stats([x['savingFraction'] for x in pairs])
    equivalent=all(x['sameWholeRank'] and x['sameEvidence'] for x in pairs)
    accepted=equivalent and saving['median']>=.20 and optimized['p95']<=originals['p95']
    save('paired-performance.json',{'at':now(),'originalMs':originals,'bucketedMs':optimized,
        'savingFraction':saving,'sameWholeRank':sum(x['sameWholeRank'] for x in pairs),'sameEvidence':sum(x['sameEvidence'] for x in pairs),
        'equivalentOnDevelopment':equivalent,'optimizationAccepted':accepted,'productResolver500msPassed':optimized['p95']<=500,
        'initializeMs':init_ms,'wallMs':(time.perf_counter()-all_start)*1000,
        'retainedMethod':'length-buckets' if accepted else 'original full cross encoder; failed optimization trial preserved',
        'newMaterialsRead':False,'remoteModelCalls':0})
    print(json.dumps(read('paired-performance.json')),flush=True)

if __name__=='__main__':main()
