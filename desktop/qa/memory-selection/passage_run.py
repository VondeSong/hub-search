"""Freeze method first, then consume a separate new frozen validation once."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import time

from applicability_policy import POLICY,SCHEMA,validate_decisions
from passage_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,digest,save,read
from passage_model import call,BASE


def sources():
    names=['passage_support.py','passage_index.py','passage_model.py','passage_run.py',
           'applicability_policy.py','run.py']
    return {name:digest(Path(__file__).with_name(name)) for name in names}


def method():
    dev=read('development-retrieval-v2.json')
    probes=read('development-latency.json')
    assert dev['status']=='completed' and not dev['residual']
    assert probes['status']=='completed'
    by_id={}
    for row in probes['results']:
        by_id.setdefault(row['id'],{})[row['compact']]=row
    same=all(set(rows)=={False,True} and rows[False]['checked']['ids']==rows[True]['checked']['ids']
             and not rows[False]['checked']['invalid'] and not rows[True]['checked']['invalid']
             for rows in by_id.values())
    save('method-contract.json',{'format':'hub-hbm-passage-method-v1','model':MODEL,'reasoning':EFFORT,
        'recipe':dev['chosen'],'compactBase':same,'developmentProbeOutcomesMatch':same,
        'developmentCorpusSha256':read('development-contract.json')['developmentCorpusSha256'],
        'developmentResultsSha256':digest(REPORTS/'development-retrieval-v2.json'),
        'latencyProbesSha256':digest(REPORTS/'development-latency.json'),
        'sources':sources(),'policy':POLICY,'schema':SCHEMA,'baseInstructions':BASE if same else 'Original Codex base',
        'representation':{'paragraphAware':True,'bodyTokenLimit':256,'overlapTokens':32,'rawPassageLimit':80,
                          'parentPoolLimit':20,'finalParentLimit':5,'judgeContext':'Full canonical bodies, not isolated passages'},
        'gates':{'candidateRecallAt5':.9,'selectedRecall':.9,'noAnswerFalseSelections':0,
                 'selectedPrecision':.8,'invalidDecisions':0,'scopeStateViolations':0},
        'performance':'Record per-question retrieval, model and end-to-end median/P95/max. Same-model development probes are the controlled latency comparison; old Astra results are historical only.',
        'validationLimit':1,'postFreezeTuningAllowed':False,'explicitRetries':0,
        'scope':'HBM-00 isolated only, backend undecided, no production or later batches',
        'stop':'Create and freeze new questions after this method; retain any validation failure without changing policy, recipe or questions.'})
    print(json.dumps({'recipe':dev['chosen'],'compactBase':same,'model':MODEL,'reasoning':EFFORT}))


def evaluate():
    from passage_index import Index
    fixed=read('method-contract.json')
    val=read('validation-contract.json')
    assert fixed['sources']==sources()
    assert digest(REPORTS/'corpus.json')==val['corpusSha256']
    assert digest(REPORTS/'validation.json')==val['validationSha256']
    assert digest(REPORTS/'method-contract.json')==val['methodContractSha256']
    corpus=read('corpus.json')
    questions=read('validation.json')['cases']
    receipt={'format':'hub-hbm-passage-evaluation-v1','status':'starting','model':MODEL,'reasoning':EFFORT,
             'recipe':fixed['recipe'],'startedAt':datetime.now(timezone.utc).isoformat(),
             'methodContractSha256':digest(REPORTS/'method-contract.json'),
             'validationSha256':val['validationSha256'],'corpusSha256':val['corpusSha256'],
             'results':[],'explicitRetries':0,'tuningPasses':0}
    index=None
    began=time.perf_counter()
    try:
        index=Index(corpus,'validation-index')
        receipt.update({'initializeMs':index.initialize_ms,'indexPrepareMs':index.prepare_ms,
                        'passages':len(index.passages),'canonicalFiles':index.files})
        # If chosen, explicitly prepare the cached local reranker outside warm query timing.
        if fixed['recipe']=='reranked':
            from fastembed.rerank.cross_encoder import TextCrossEncoder
            start=time.perf_counter()
            index.reranker=TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8',threads=2,
                cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True)
            receipt['rerankerPrepareMs']=(time.perf_counter()-start)*1000
        for number,q in enumerate(questions,1):
            start=time.perf_counter()
            found=index.search(q['query'],q['project'],rerank=fixed['recipe']=='reranked')
            candidates=index.candidates(found[fixed['recipe']],q['project'])
            retrieval_ms=(time.perf_counter()-start)*1000
            task={'id':q['id'],'project':q['project'],'question':q['query'],
                  'candidateIds':[m['id'] for m in candidates]}
            payload={'project':{'id':q['project'],'name':corpus['projects'][q['project']]},
                     'memories':candidates,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            response,model_receipt=call(prompt,SCHEMA,f'validation-{number:03}',compact=fixed['compactBase'])
            checked=validate_decisions(response,[task],candidates)[0]
            # Re-read and hash final selected source after model wait.
            for mid in checked['ids']:
                file=index.files[mid]
                if digest(file['path'])!=file['sha256']:
                    raise ValueError('Final source changed during model judgement')
            row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,
                 'retrievalMs':retrieval_ms,'modelMs':model_receipt['durationMs'],
                 'endToEndMs':(time.perf_counter()-start)*1000,
                 'checked':checked,'modelReceipt':model_receipt}
            save(f'validation-{number:03}.json',row)
            receipt['results'].append(row)
            print(json.dumps({'completed':number,'total':len(questions),'e2eMs':round(row['endToEndMs'],2)}),flush=True)
        receipt['status']='completed'
    except BaseException as error:
        receipt.update({'status':'failed','errorType':type(error).__name__})
        raise
    finally:
        if index:
            index.close()
            receipt['residual']=index.residual
            receipt['mcpExitCode']=index.client.process.returncode
        receipt['totalMs']=(time.perf_counter()-began)*1000
        save('evaluation.json',receipt)
    print(json.dumps({'status':receipt['status'],'questions':len(receipt['results']),'residual':receipt.get('residual')}))


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('phase',choices=['method','evaluate'])
    args=p.parse_args()
    {'method':method,'evaluate':evaluate}[args.phase]()
