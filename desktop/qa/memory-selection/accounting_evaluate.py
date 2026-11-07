"""One new holdout; method frozen before authoring any new facts/questions."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import time
from applicability_policy import POLICY,SCHEMA,validate_decisions
from accounting_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,digest,save,read
from accounting_transport import Wire,ledger

def sources():
    names=['accounting_support.py','accounting_transport.py','accounting_evaluate.py','connection_transport.py',
           'latency_transport.py','latency_reuse.py','applicability_policy.py',
           'passage_index.py','passage_support.py','passage_model.py','run.py']
    return {name:digest(Path(__file__).with_name(name)) for name in names}

def freeze_method():
    dev=read('development-audit.json')
    assert dev['status']=='completed' and dev['turns']==48 and dev['chosen']=='persistent-ws'
    save('method-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),'model':MODEL,'effort':EFFORT,'tier':'default',
        'transport':'persistent-ws','actualCrossQuestionRemoteReuse':False,
        'selectionEvidenceSha256':digest(REPORTS/'development-audit.json'),
        'retrieval':'Unchanged token passages/vector + Chinese FTS5/jieba RRF60, raw80 parent20 final5. No reranker.',
        'policy':POLICY,'schema':SCHEMA,'sources':sources(),'formalOtelExporter':True,
        'freshEmptyHistoryEveryQuestion':True,'ephemeral':True,'explicitRetries':0,
        'validationExecutionsMax':1,'postFreezeTuningAllowed':False,
        'gates':read('scope-contract.json')['holdout']['qualityGates'],
        'newDataPlan':{'previousRecords':208,'realNotes':10,'realPositiveQuestions':20,'newSyntheticNotes':10,
            'syntheticPositiveQuestions':20,'stateGuards':8,'nearSubjectDistractors':30,'totalRecords':266,
            'negative':100,'positive':40,'realExtraction':'Full note when <=2048 cached BGE tokens, else one continuous initial <=2048-token section; preserve exact source offsets and original hash. No query/rank-driven extraction.',
            'sourceProjects':['parts','reading','hub','real-notes'],'knownFailureTypes':['long-tail facts','near IDs and versions','weak lexical wording','conditional scopes'],
            'newFailureTypes':['quote vs instruction','source statement vs actual user event','negated/default scope vs exception','partial numeric identity']},
        'candidatePresentation':'Keep membership and original retrieval ranks; rotate up to five candidates by opaque question-ID hash modulo count, without reading labels. Report presentation position separately from retrieval rank.',
        'negativeUpperBound':'Zero/100 gives one-sided 95% binomial bound 1-0.05**0.01 (~2.95%) under IID assumption; correlated constructed cases do not establish population error.',
        'stop':'This is the last latency/accounting round. Next work is remaining backend gates, no further latency tuning.'})
    print('Method frozen before new note selection and new questions.')


def evaluate():
    import passage_index
    passage_index.WORK=WORK
    method=read('method-contract.json'); contract=read('validation-contract.json')
    assert method['sources']==sources()
    assert digest(REPORTS/'method-contract.json')==contract['methodContractSha256']
    assert digest(REPORTS/'corpus.json')==contract['corpusSha256']
    assert digest(REPORTS/'validation.json')==contract['validationSha256']
    # Exclusive marker forbids an accidental second formal execution, even after failure.
    save('execution-start.json',{'at':datetime.now(timezone.utc).isoformat(),'sources':sources(),
         'methodSha256':contract['methodContractSha256'],'executionNumber':1})
    corpus=read('corpus.json'); questions=read('validation.json')['cases']; assert len(questions)==140
    result={'status':'starting','model':MODEL,'effort':EFFORT,'transport':'persistent',
            'results':[],'explicitRetries':0,'startedAt':datetime.now(timezone.utc).isoformat()}
    index=wire=None
    started=time.perf_counter()
    try:
        index=passage_index.Index(corpus,'validation-index')
        result.update({'indexPrepareMs':index.prepare_ms,'mcpInitializeMs':index.initialize_ms,
                       'canonicalFiles':index.files,'passages':len(index.passages)})
        print(json.dumps({'stage':'index-ready','records':len(index.files),'passages':len(index.passages),
                          'prepareMs':index.prepare_ms}),flush=True)
        model_started=time.perf_counter()
        wire=Wire(WORK/'validation-server',http=False)
        result['persistentInitializeMs']=wire.initialize_ms
        for number,q in enumerate(questions,1):
            began=time.perf_counter()
            found=index.search(q['query'],q['project'],rerank=False)
            candidates=index.candidates(found['fused'],q['project'])
            if candidates:
                rotate=int(q['id'][2:10],16)%len(candidates)
                candidates=candidates[rotate:]+candidates[:rotate]
            retrieval_ms=(time.perf_counter()-began)*1000
            task={'id':q['id'],'project':q['project'],'question':q['query'],
                  'candidateIds':[m['id'] for m in candidates]}
            payload={'project':{'id':q['project'],'name':corpus['projects'][q['project']]},'memories':candidates,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            model_start_ns=time.time_ns()
            response,receipt=wire.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')
            model_end_ns=time.time_ns()
            checked=validate_decisions(response,[task],candidates)[0]
            for mid in checked['ids']:
                assert digest(index.files[mid]['path'])==index.files[mid]['sha256']
            row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,
                 'modelStartUnixNs':model_start_ns,'modelEndUnixNs':model_end_ns,
                 'retrievalMs':retrieval_ms,'modelMs':receipt['durationMs'],
                 'endToEndMs':(time.perf_counter()-began)*1000,'checked':checked,'modelReceipt':receipt}
            save(f'validation-{number:03}.json',row); result['results'].append(row)
            # Progress contains durations only; do not score or inspect holdout outcomes mid-run.
            print(json.dumps({'completed':number,'total':140,'endToEndMs':round(row['endToEndMs'],2)}),flush=True)
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__})
        raise
    finally:
        if wire:
            if result['status']=='completed':
                result['modelDrain']=wire.drain(2*len(result['results']))
            wire.close()
            result['modelBatchWallMs']=(time.perf_counter()-model_started)*1000
            if result['status']=='completed':
                result['fullModelLedger']=ledger(wire.telemetry.rows,[{'id':r['id'],'startUnixNs':r['modelStartUnixNs'],'endUnixNs':r['modelEndUnixNs'],'receipt':r['modelReceipt']} for r in result['results']])
        if index:
            index.close(); result['mcpResidual']=index.residual; result['mcpExitCode']=index.client.process.returncode
        result['totalMs']=(time.perf_counter()-started)*1000
        save('evaluation.json',result)
    print(json.dumps({'status':result['status'],'questions':len(result['results'])}))

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('phase',choices=['method','evaluate'])
    {'method':freeze_method,'evaluate':evaluate}[p.parse_args().phase]()
