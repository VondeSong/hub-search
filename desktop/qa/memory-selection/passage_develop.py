"""Previously disclosed set is development only; new validation comes later."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics

from applicability_policy import POLICY, SCHEMA, validate_decisions
from passage_support import ROOT, WORK, PREVIOUS, save, read, digest, MODEL, EFFORT
from passage_model import call


def freeze():
    save('development-contract.json', {
        'scope':'HBM-00 only, no production or backend decision',
        'model':MODEL,'reasoning':EFFORT,'excludedModels':['gpt-6-astra'],
        'developmentCorpusSha256':digest(PREVIOUS/'corpus.json'),
        'developmentQuestionsSha256':digest(PREVIOUS/'validation.json'),
        'previousSetStatus':'Explicitly development data now, cannot serve as new holdout',
        'retrievalCandidates':['vector','fused','reranked'],
        'fixedRepresentation':{'paragraphAware':True,'bodyTokenLimit':256,'overlapTokens':32,
                               'titleTokenLimit':48,'rawPassageLimit':80,'parentPoolLimit':20,'finalParentLimit':5},
        'selection':'Maximize positive development Recall@5, ties choose lower measured median retrieval cost, then vector/fused/reranked order. No semantic threshold fitting.',
        'latencyProbe':'Four first opaque-ID sorted development questions, identical payloads across original/compact bases. gpt-6.1-sol xhigh in both. One call per arm per question, no retries.',
        'newHoldout':'Author and freeze after representation, retrieval recipe and model transport are fixed; never use holdout labels to select these.',
        'stop':'One development comparison per declared recipe, then one new-set validation; preserve failures.'})
    print('Three generic retrieval recipes and latency-control probes fixed')


def retrieval():
    from passage_index import Index
    corpus=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    cases=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    assert digest(PREVIOUS/'corpus.json')==read('development-contract.json')['developmentCorpusSha256']
    index=None
    receipt={'status':'starting','results':[]}
    try:
        index=Index(corpus,'development-index-v2')
        receipt.update({'initializeMs':index.initialize_ms,'prepareMs':index.prepare_ms,
                        'passages':len(index.passages),'canonicalRecords':len(index.records)})
        for i,q in enumerate(cases):
            row=index.search(q['query'],q['project'],rerank=True)
            receipt['results'].append({'id':q['id'],**row})
            if (i+1)%10==0:
                print(json.dumps({'developmentQueries':i+1,'total':len(cases)}),flush=True)
        metrics={}
        for recipe in ['vector','fused','reranked']:
            correct=sum(bool(set(q['expected'])&set(r[recipe][:5])) for q,r in zip(cases,receipt['results']) if q['expected'])
            elapsed=[r['retrievalMs'] if recipe=='reranked' else r['retrievalMs']-r['rerankMs'] for r in receipt['results']]
            metrics[recipe]={'correctAt5':correct,'positive':40,'recallAt5':correct/40,
                              'approximateMedianMs':statistics.median(elapsed),
                              'note':'Vector/fused times include shared lexical work; final chosen recipe measured alone on new set'}
        order={'vector':0,'fused':1,'reranked':2}
        chosen=sorted(metrics,key=lambda k:(-metrics[k]['recallAt5'],metrics[k]['approximateMedianMs'],order[k]))[0]
        receipt.update({'status':'completed','metrics':metrics,'chosen':chosen})
    finally:
        if index:
            index.close()
            receipt['residual']=index.residual
        save('development-retrieval-v2.json',receipt)
    print(json.dumps({'metrics':metrics,'chosen':chosen,'residual':receipt['residual']},ensure_ascii=False))


def latency():
    previous=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))
    cases={q['id']:q for q in json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']}
    probes=sorted(previous['results'],key=lambda r:r['id'])[:4]
    results=[]
    for index,row in enumerate(probes):
        q=cases[row['id']]
        candidates=row['candidates']
        task={'id':q['id'],'project':q['project'],'question':q['query'],
              'candidateIds':[m['id'] for m in candidates]}
        payload={'project':{'id':q['project']},'memories':candidates,'tasks':[task]}
        prompt=POLICY+'\n待核验数据：\n'+json.dumps(payload,ensure_ascii=False)
        # Alternate order to avoid giving one arm all early/late provider conditions.
        for compact in ([False,True] if index%2==0 else [True,False]):
            response,receipt=call(prompt,SCHEMA,f'dev-model-{index+1:02}-'+('compact' if compact else 'original'),compact=compact)
            checked=validate_decisions(response,[task],candidates)[0]
            results.append({'id':q['id'],'compact':compact,'receipt':receipt,'checked':checked})
            print(json.dumps({'probe':index+1,'compact':compact,'durationMs':receipt['durationMs'],
                              'inputTokens':receipt['usage']['input_tokens']}),flush=True)
    summary={}
    for compact in [False,True]:
        rows=[r for r in results if r['compact']==compact]
        summary['compact' if compact else 'original']={
            'medianMs':statistics.median(r['receipt']['durationMs'] for r in rows),
            'inputTokens':sum(r['receipt']['usage']['input_tokens'] for r in rows),
            'invalid':sum(bool(r['checked']['invalid']) for r in rows)}
    save('development-latency.json',{'status':'completed','model':MODEL,'reasoning':EFFORT,
                                    'results':results,'summary':summary,
                                    'limits':'Four development probes, not stable provider latency or new validation scores.'})
    print(json.dumps(summary))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['freeze','retrieval','latency'])
    args=parser.parse_args()
    {'freeze':freeze,'retrieval':retrieval,'latency':latency}[args.phase]()
