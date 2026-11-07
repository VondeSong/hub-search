"""Frozen transport plus unchanged passage retrieval; one new holdout execution."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from applicability_policy import POLICY, SCHEMA, validate_decisions
from latency_support import ROOT, WORK, REPORTS, PREVIOUS, MODEL, EFFORT, digest, save, read
from latency_transport import Wire


def sources():
    names=['latency_support.py','latency_transport.py','latency_reuse.py','latency_evaluate.py','latency_develop.py',
           'applicability_policy.py','passage_index.py','passage_support.py','passage_model.py','run.py']
    return {name:digest(Path(__file__).with_name(name)) for name in names}


def freeze_method():
    dev=read('development.json')
    assert dev['status']=='completed' and len(dev['results'])==36
    old_sources=read('development-contract.json')['actorSources']
    assert old_sources=={k:sources()[k] for k in old_sources}
    reuse=read('reuse-development.json')
    chosen=reuse['chosen']
    save('method-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),'model':MODEL,'effort':EFFORT,
        'transport':chosen,'developmentImprovementDemonstrated':reuse['improvementDemonstrated'] if chosen=='reuse' else dev['improvementDemonstrated'],
        'retrieval':'Unchanged passage vector + Chinese FTS5/jieba RRF60; raw80 parent20 final5.',
        'priorMethodSha256':digest(PREVIOUS/'method-contract.json'),'policy':POLICY,'schema':SCHEMA,
        'sources':sources(),'formalOtelExporter':False,'freshEmptyHistoryEveryQuestion':True,
        'ephemeral':chosen!='reuse',
        'sharedState':'One experiment-owned native Codex metadata state, prepared once; never reuse question history.',
        'gates':read('scope-contract.json')['validation']['gates'],
        'validationExecutionsMax':1,'postFreezeTuningAllowed':False,'explicitRetries':0,
        'timingLimit':'Client phases are observed boundaries. No pure network, server queue, prefill or hidden reasoning duration without server timing.'})
    print(json.dumps({'transport':chosen,'methodFrozen':True}))


def evaluate():
    import passage_index
    passage_index.WORK=WORK
    method=read('method-contract.json')
    contract=read('validation-contract.json')
    assert method['sources']==sources()
    assert digest(REPORTS/'method-contract.json')==contract['methodContractSha256']
    assert digest(REPORTS/'corpus.json')==contract['corpusSha256']
    assert digest(REPORTS/'validation.json')==contract['validationSha256']
    questions=read('validation.json')['cases']
    corpus=read('corpus.json')
    result={'status':'starting','model':MODEL,'effort':EFFORT,'transport':method['transport'],
            'results':[],'explicitRetries':0,'startedAt':datetime.now(timezone.utc).isoformat()}
    started=time.perf_counter()
    index=wire=None
    try:
        index=passage_index.Index(corpus,'validation-index')
        result.update({'indexPrepareMs':index.prepare_ms,'mcpInitializeMs':index.initialize_ms,
                       'canonicalFiles':index.files,'passages':len(index.passages)})
        if method['transport']=='reuse':
            from latency_reuse import ReusableSession
            wire=ReusableSession('validation-reuse')
            result['persistentInitializeMs']=wire.wire.initialize_ms
        elif method['transport']=='persistent':
            wire=Wire(WORK/'validation-persistent','app')
            result['persistentInitializeMs']=wire.initialize_ms
        for number,q in enumerate(questions,1):
            began=time.perf_counter()
            found=index.search(q['query'],q['project'],rerank=False)
            candidates=index.candidates(found['fused'],q['project'])
            retrieval_ms=(time.perf_counter()-began)*1000
            task={'id':q['id'],'project':q['project'],'question':q['query'],
                  'candidateIds':[m['id'] for m in candidates]}
            payload={'project':{'id':q['project'],'name':corpus['projects'][q['project']]},
                     'memories':candidates,'tasks':[task]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
            local=None
            try:
                if method['transport']=='reuse':
                    response,receipt=wire.call(prompt,SCHEMA,WORK/f'validation-{number:03}')
                    call_ms=receipt['durationMs']
                elif method['transport']=='persistent':
                    response,receipt=wire.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')
                    call_ms=receipt['durationMs']
                else:
                    mode='cli' if method['transport']=='cli' else 'app'
                    local=Wire(WORK/f'validation-{number:03}-server',mode,SCHEMA if mode=='cli' else None)
                    if mode=='cli':
                        response,receipt=local.cli_call(prompt,SCHEMA)
                    else:
                        response,receipt=local.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')
                    call_ms=(time.perf_counter()-local.began)*1000
                checked=validate_decisions(response,[task],candidates)[0]
                for mid in checked['ids']:
                    file=index.files[mid]
                    assert digest(file['path'])==file['sha256']
                row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,
                     'retrievalMs':retrieval_ms,'modelMs':call_ms,'endToEndMs':(time.perf_counter()-began)*1000,
                     'checked':checked,'modelReceipt':receipt}
                save(f'validation-{number:03}.json',row)
                result['results'].append(row)
                print(json.dumps({'completed':number,'total':80,'endToEndMs':round(row['endToEndMs'],2)}),flush=True)
            finally:
                if local:
                    local.close()
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__})
        raise
    finally:
        if wire:
            wire.close()
        if index:
            index.close()
            result['mcpResidual']=index.residual
            result['mcpExitCode']=index.client.process.returncode
        result['totalMs']=(time.perf_counter()-started)*1000
        save('evaluation.json',result)
    print(json.dumps({'status':result['status'],'questions':len(result['results'])}))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['method','evaluate'])
    {'method':freeze_method,'evaluate':evaluate}[parser.parse_args().phase]()
