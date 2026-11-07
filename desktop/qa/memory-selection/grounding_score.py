"""Prospectively frozen factual-core scorer, with source-ID diagnostic."""
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from grounding_support import *

def stats(values):
    v=sorted(values)
    return {'n':len(v),'median':statistics.median(v) if v else None,'p95':v[max(0,math.ceil(.95*len(v))-1)] if v else None,'max':max(v) if v else None}

def core_match(evidence,mid,text):
    return any(e['id']==mid and any(core in text for core in e['cores']) for e in evidence)

def score(rows,cases):
    details=[];hit5=hit20=selected=source_selected=delivered=false=invalid=violations=0
    initial_ranks=[];final_ranks=[]
    for row in rows:
        q=cases[row['id']];r=row['retrieval'];check=row['checked']
        mids={m['id'] for m in r['candidates']}
        gold=set(q['expected']);chosen=check['ids'][0] if check['ids'] else ''
        rank=lambda field:min([r[field].index(mid)+1 for mid in gold if mid in r[field]] or [0]) or None
        first,final=rank('preRerank'),rank('fused')
        has=any(core_match(q['evidence'],m['id'],m['text']) for m in r['candidates'])
        correct=bool(chosen) and core_match(q['evidence'],chosen,check['decision']['quote'])
        if gold:
            hit5+=bool(gold&mids);hit20+=bool(gold&set(r['fused']));source_selected+=chosen in gold
            delivered+=has;selected+=correct;initial_ranks.append(first);final_ranks.append(final)
        else:false+=bool(chosen)
        invalid+=bool(check['invalid'])
        for m in r['candidates']:
            violations+=m['project']!=q['project'] or m['status']!='confirmed'
        details.append({'id':q['id'],'category':q['category'],'positive':bool(gold),'initialRank':first,'finalRank':final,
            'candidateHit':bool(gold&mids),'evidenceDelivered':has,'selectedCorrect':correct,'selectedSourceCorrect':chosen in gold,
            'checked':check,'expected':q['expected']})
    positive=sum(bool(q['expected']) for q in cases.values());negative=len(cases)-positive
    chosen=sum(bool(r['checked']['ids']) for r in rows)
    quality={'positive':positive,'negative':negative,'candidateHitAt5':hit5,'candidateRecallAt5':hit5/positive,
        'candidateHitAt20':hit20,'candidateRecallAt20':hit20/positive,'evidenceDelivered':delivered,
        'selectedSourceCorrect':source_selected,'selectedCorrect':selected,'selectedRecall':selected/positive,
        'selectedPrecision':selected/chosen if chosen else 0,'negativeFalseSelections':false,'invalidDecisions':invalid,'scopeStateViolations':violations,
        'zeroEvent95UpperBound':1-.05**(1/negative) if false==0 else None,
        'initialRanks':dict(Counter(str(x) for x in initial_ranks)),'finalRanks':dict(Counter(str(x) for x in final_ranks))}
    quality['numericGatePassed']=hit5/positive>=.90 and selected/positive>=.90 and quality['selectedPrecision']>=.80 and false==0 and invalid==0 and violations==0
    return {'quality':quality,'details':details,'observedRetrievalMs':stats([r['retrieval']['retrievalMs'] for r in rows]),
            'evidenceTokens':stats([r['retrieval']['memoryBgeTokens'] for r in rows])}

def main():
    assert read('method-contract.json')['sources']==sources()
    frozen=read('validation-contract.json');evaluation=read('evaluation.json');cases={q['id']:q for q in read('validation.json')['cases']}
    assert evaluation['status']=='completed' and len(evaluation['rows'])==2*len(cases)
    assert frozen['scorerSha256']==digest(Path(__file__))
    outputs={b:score([r for r in evaluation['rows'] if r['backend']==b],cases) for b in ['hub-native-hybrid','basic-memory-hybrid']}
    save('scored-results.json',outputs)
    ledgers=[read('development-model.json')['ledger'],evaluation['ledger']]
    cost={k:sum(x[k] for x in ledgers) for k in ['responseRequests','prewarmRequests','unusedFinalPrewarmRequests','totalInputTokens','totalOutputTokens','cachedInputTokens','totalTokens','allNetworkRequestCount']}
    cost.update({'modelTurns':sum(len(x['requests'])-x['prewarmRequests'] for x in ledgers),
        'developmentModelTurns':len(read('development-model.json')['calls']),'formalModelTurns':len(evaluation['modelCalls']),
        'formalModelBatchWallMs':evaluation['modelBatchWallMs'],'formalFullWallMs':evaluation['totalMs'],
        'developmentRetrievalWallMs':read('development-retrieval.json')['wallMs'],'developmentModelWallMs':read('development-model.json')['wallMs'],
        'primaryAgentAndLocalEmbeddingTokens':'unknown, not zero','billing':'processed workload incl all warmup, not invoice',
        'latencyComparison':'No same-dataset latency optimization experiment; cache shared evidence resolution between identical backend inputs, report cold and cached separately'})
    primary=next(iter(outputs.values()))['details'];positives=[d for d in primary if d['positive']]
    coverage={'positive':len(positives),'initialNonfirst':sum(d['initialRank'] is None or d['initialRank']>1 for d in positives),
              'initialBeyond5':sum(d['initialRank'] is None or d['initialRank']>5 for d in positives),
              'finalNonfirst':sum(d['finalRank'] is None or d['finalRank']>1 for d in positives),
              'finalBeyond5':sum(d['finalRank'] is None or d['finalRank']>5 for d in positives)}
    coverage['retrievalTailDemonstrated']=coverage['initialNonfirst']>=6 and coverage['initialBeyond5']>=2
    source_audit=[{'id':s['id'],'snapshotUnchanged':digest(s['snapshot'])==s['sha256'],
                  'originalUnchanged':Path(s['path']).exists() and digest(s['path'])==s['sha256']} for s in read('real-notes.json')['sources']]
    summary={'at':now(),'quality':{b:v['quality'] for b,v in outputs.items()},'tailCoverage':coverage,'cost':cost,
        'indexes':evaluation['indexes'],'modelCallMs':stats([c['receipt']['durationMs'] for c in evaluation['modelCalls']]),
        'observedRetrievalMs':{b:v['observedRetrievalMs'] for b,v in outputs.items()},'evidenceTokens':next(iter(outputs.values()))['evidenceTokens'],
        'lexicalNonempty':sum(bool(r['retrieval']['lexical']) for r in evaluation['rows'][::2]),
        'sourceAudit':source_audit,'bmResidual':evaluation['bmResidual'],'backendSelected':False,'laterBatchesStarted':False,
        'limitations':['Shared BM parser representation; common Hub lexical/evidence/reranker; component test, not full product comparison',
          'Python native embedding fixture, not shipping Rust runtime; no independent BM-free deployment proof',
          'Author and judge same model family; all cores prospectively audited by primary author, not independent annotation',
          '100 constructed negatives are correlated; zero-event bound assumes iid and is illustrative only',
          'Candidate budget up to6000 BGE tokens instead of2000; no speed/cost gain claim',
          'Target-scale hot P95,20 real task effects,lifecycle/forgetting,managed Windows runtime,24h soak and distribution gates remain open']}
    save('summary.json',summary)
    print(json.dumps({k:summary[k] for k in ['quality','tailCoverage','cost','modelCallMs','observedRetrievalMs','evidenceTokens','lexicalNonempty']},ensure_ascii=False))

if __name__=='__main__':main()
