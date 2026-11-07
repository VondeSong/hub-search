"""Frozen scorer: no query, label, excerpt, policy or threshold changes."""
from collections import Counter
import json
import math
import statistics
from parity_support import *
from parity_evaluate import source_hashes

def percentile(values,p):
    ordered=sorted(values)
    return ordered[max(0,math.ceil(len(ordered)*p)-1)] if ordered else None

def statistics_ms(values):
    return {'n':len(values),'median':statistics.median(values) if values else None,
            'p95':percentile(values,.95),'max':max(values) if values else None}

def score(rows,cases):
    positive=negative=hit5=hit20=selected=note_selected=false=invalid=violations=evidence_hits=0
    details=[]
    for row in rows:
        q=cases[row['id']]; found=row['retrieval']; check=row['checked']
        ids=[m['id'] for m in found['candidates']]
        invalid+=bool(check['invalid'])
        by_mid={m['id']:m for m in found['candidates']}
        for mid in check['ids']:
            m=by_mid[mid]
            violations+=m['project']!=q['project'] or m['status']!='confirmed'
            assert check['decision']['quote'] in m['text']
        ranks=[found['fused'].index(mid)+1 for mid in q['expected'] if mid in found['fused']]
        rank=min(ranks) if ranks else None
        strict=False
        if q['expected']:
            positive+=1
            hit5+=bool(set(q['expected']) & set(ids))
            hit20+=bool(set(q['expected']) & set(found['fused']))
            note_selected+=bool(set(q['expected']) & set(check['ids']))
            evidence_hit=any(e['id'] in by_mid and all(f in by_mid[e['id']]['text'] for f in e['required']) for e in q['evidence'])
            evidence_hits+=evidence_hit
            strict=any(e['id'] in check['ids'] and all(f in check['decision']['quote'] for f in e['required']) for e in q['evidence'])
            selected+=strict
        else:
            negative+=1
            false+=bool(check['ids'])
            evidence_hit=False
        details.append({'id':q['id'],'query':q['query'],'category':q['category'],'positive':bool(q['expected']),
            'goldRank':rank,'candidateHit':bool(set(q['expected'])&set(ids)),
            'evidencePassageHit':evidence_hit,'strictSelectedCorrect':strict,
            'selectedIds':check['ids'],'expected':q['expected'],'checked':check,'evidence':q['evidence'],
            'evidenceOffsets':q.get('evidenceOffsets',[]),'fused':found['fused']})
    selected_total=sum(bool(r['checked']['ids']) for r in rows)
    quality={'positive':positive,'negative':negative,'candidateHitAt5':hit5,'candidateRecallAt5':hit5/positive,
        'candidateHitAt20':hit20,'candidateRecallAt20':hit20/positive,'evidencePassageHit':evidence_hits,
        'sourceIdSelected':note_selected,'strictSelectedCorrect':selected,'selectedRecall':selected/positive,
        'selectedPrecision':selected/selected_total if selected_total else 0,'negativeFalseSelections':false,
        'invalidDecisions':invalid,'scopeStateViolations':violations}
    gates=read('scope-contract.json')['gates']
    quality['numericGatePassed']=all([quality['candidateRecallAt5']>=gates['candidateRecallAt5'],
        quality['selectedRecall']>=gates['selectedRecall'],quality['selectedPrecision']>=gates['selectedPrecision'],
        false==0,invalid==0,violations==0])
    quality['goldRankDistribution']=dict(Counter(str(r['goldRank']) for r in details if r['positive']))
    return {'quality':quality,'details':details,'retrievalMs':statistics_ms([r['retrieval']['retrievalMs'] for r in rows]),
        'memoryBgeTokens':statistics_ms([r['retrieval']['memoryBgeTokens'] for r in rows]),
        'budgetDropped':sum(bool(r['retrieval']['budgetDropped']) for r in rows)}

if __name__=='__main__':
    contract=read('validation-contract.json'); evaluation=read('evaluation.json')
    assert contract['scorerSha256']==digest(Path(__file__))
    assert evaluation['status']=='completed' and len(evaluation['rows'])==248
    assert read('method-contract.json')['sources']==source_hashes()
    assert contract['corpusSha256']==digest(REPORTS/'corpus.json')
    assert contract['validationSha256']==digest(REPORTS/'validation.json')
    cases={q['id']:q for q in read('validation.json')['cases']}
    outputs={backend:score([r for r in evaluation['rows'] if r['backend']==backend],cases)
             for backend in ['hub-native-hybrid','basic-memory-hybrid']}
    tail=[]
    for q in cases.values():
        if not q['expected']:
            continue
        ranks={backend:next(r['goldRank'] for r in value['details'] if r['id']==q['id']) for backend,value in outputs.items()}
        tail.append({'id':q['id'],'ranks':ranks,'beyond1':any(r is None or r>1 for r in ranks.values()),
                     'beyond5':any(r is None or r>5 for r in ranks.values())})
    coverage={'positive':24,'beyond1':sum(t['beyond1'] for t in tail),'beyond5OrMissing':sum(t['beyond5'] for t in tail),
              'requiredBeyond1':6,'requiredBeyond5OrMissing':2,'rows':tail}
    coverage['retrievalTailDemonstrated']=coverage['beyond1']>=6 and coverage['beyond5OrMissing']>=2
    ledgers=[read('preflight.json')['ledger'],evaluation['ledger']]
    cost={'modelTurns':sum(len(x['requests'])-x['prewarmRequests'] for x in ledgers),
          'responseRequests':sum(x['responseRequests'] for x in ledgers),
          'prewarmRequests':sum(x['prewarmRequests'] for x in ledgers),
          'unusedFinalPrewarmRequests':sum(x['unusedFinalPrewarmRequests'] for x in ledgers),
          'totalInputTokens':sum(x['totalInputTokens'] for x in ledgers),
          'totalOutputTokens':sum(x['totalOutputTokens'] for x in ledgers),
          'cachedInputTokens':sum(x['cachedInputTokens'] for x in ledgers),
          'totalTokens':sum(x['totalTokens'] for x in ledgers),
          'allNetworkRequests':sum(x['allNetworkRequestCount'] for x in ledgers),
          'formalModelBatchWallMs':evaluation['modelBatchWallMs'],'formalFullWallMs':evaluation['totalMs'],
          'preflightFullWallMs':read('preflight.json')['wallMs'],
          'sharedIdenticalJudgements':sum(r['sharedIdenticalJudgement'] for r in evaluation['rows']),
          'tokensMeaning':'Processed workload including all observed warmup, not an invoice; primary authoring/orchestration usage and service-internal requests unknown, not zero.'}
    source_unchanged=all(digest(s['path'])==s['sha256'] and digest(s['snapshot'])==s['sha256'] for s in read('real-notes.json')['sources'])
    summary={'createdAt':now(),'backendUndecided':True,'laterBatchesStarted':False,'latencyOptimization':False,
        'quality':{b:v['quality'] for b,v in outputs.items()},'tailCoverage':coverage,'cost':cost,
        'indexes':evaluation['indexes'],'sourceFilesUnchanged':source_unchanged,
        'bmResidual':evaluation['bmResidual'],'modelCallMs':statistics_ms([c['receipt']['durationMs'] for c in evaluation['modelCalls']]),
        'limitations':['Common representation depends on BM parser export; component comparison only.',
                      'Native vectors run in Python; Rust embedding runtime and Windows packaging unverified.',
                      '48 selected notes plus8 authority controls is not the frozen production target scale.',
                      'BGE input budget proxy is not exact Sol production-token validation.',
                      'Same-family author and judge; not independent annotation; negative cases correlated.',
                      'Lifecycle,20 real task effects, managed Windows installation,24h soak and distribution gates remain open.']}
    save('scored-results.json',outputs)
    save('summary.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k not in ['tailCoverage','indexes']},ensure_ascii=False))
