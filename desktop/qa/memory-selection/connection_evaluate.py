"""One new holdout; method frozen before authoring any new facts/questions."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import time
from applicability_policy import POLICY,SCHEMA,validate_decisions
from connection_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,digest,save,read
from connection_transport import Wire

def sources():
    names=['connection_support.py','connection_transport.py','connection_evaluate.py',
           'latency_transport.py','latency_reuse.py','applicability_policy.py',
           'passage_index.py','passage_support.py','passage_model.py','run.py']
    return {name:digest(Path(__file__).with_name(name)) for name in names}

def freeze_method():
    dev=read('development-audit.json')
    assert dev['status']=='completed' and dev['observations']==48
    assert dev['chosen']=='persistent' and dev['actualCrossQuestionRemoteReuse'] is False
    save('method-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),'model':MODEL,'effort':EFFORT,'tier':'default',
        'transport':'persistent','candidateRejected':'Native history reset reconnects; public direct response route not authorized for current credentials.',
        'actualCrossQuestionRemoteReuse':False,'selectionEvidenceSha256':digest(REPORTS/'development-audit.json'),
        'priorMethodSha256':digest(PREVIOUS/'method-contract.json'),
        'retrieval':'Unchanged token passages + Chinese BGE vector + FTS5/jieba RRF60; raw80 parent20 final5. No reranker.',
        'policy':POLICY,'schema':SCHEMA,'sources':sources(),'formalOtelExporter':False,
        'freshEmptyHistoryEveryQuestion':True,'ephemeral':True,'explicitRetries':0,
        'validationExecutionsMax':1,'postFreezeTuningAllowed':False,
        'gates':read('scope-contract.json')['validation'],
        'newDataPlan':{'priorDistractorRecords':180,'newConfirmedNotes':20,'newStateGuardNotes':8,
                       'questions':80,'positive':40,'negative':40,'positiveQuestionsPerNewNote':2,
                       'challenges':['long mixed-topic source','late exact facts','near identifiers','conditions and units','plan vs actual','missing attributes','cross-project','inactive or candidate states','untrusted instructions as data']},
        'timingLimit':'Directly measured client boundaries only; no invented pure network/queue/inference split.'})
    print('Method frozen before new facts; native independent-thread persistent process retained.')

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
    corpus=read('corpus.json'); questions=read('validation.json')['cases']
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
        wire=Wire(WORK/'validation-server',telemetry_enabled=False)
        result['persistentInitializeMs']=wire.initialize_ms
        for number,q in enumerate(questions,1):
            began=time.perf_counter()
            found=index.search(q['query'],q['project'],rerank=False)
            candidates=index.candidates(found['fused'],q['project'])
            retrieval_ms=(time.perf_counter()-began)*1000
            task={'id':q['id'],'project':q['project'],'question':q['query'],
                  'candidateIds':[m['id'] for m in candidates]}
            payload={'project':{'id':q['project'],'name':corpus['projects'][q['project']]},'memories':candidates,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            response,receipt=wire.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')
            checked=validate_decisions(response,[task],candidates)[0]
            for mid in checked['ids']:
                assert digest(index.files[mid]['path'])==index.files[mid]['sha256']
            row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,
                 'retrievalMs':retrieval_ms,'modelMs':receipt['durationMs'],
                 'endToEndMs':(time.perf_counter()-began)*1000,'checked':checked,'modelReceipt':receipt}
            save(f'validation-{number:03}.json',row); result['results'].append(row)
            # Progress contains durations only; do not score or inspect holdout outcomes mid-run.
            print(json.dumps({'completed':number,'total':80,'endToEndMs':round(row['endToEndMs'],2)}),flush=True)
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__})
        raise
    finally:
        if wire:
            wire.close()
        if index:
            index.close(); result['mcpResidual']=index.residual; result['mcpExitCode']=index.client.process.returncode
        result['totalMs']=(time.perf_counter()-started)*1000
        save('evaluation.json',result)
    print(json.dumps({'status':result['status'],'questions':len(result['results'])}))

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('phase',choices=['method','evaluate'])
    {'method':freeze_method,'evaluate':evaluate}[p.parse_args().phase]()
