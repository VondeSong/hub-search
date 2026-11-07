"""Offline closure repair ONLY. Frozen judging/scoring and raw failure stay intact.

No inference, queries, labels, candidate order, policy or thresholds may change.
The raw runner assumed two responses per question. A connect retry suppressed
one warmup; reconcile actual sends/completions instead of manufacturing usage.
"""
import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path
import psutil
from grounding_support import *

def contract():
    save('closure-contract.json',{'at':now(),'beforeQualityScoring':not (REPORTS/'scored-results.json').exists(),
        'rawFailurePreserved':True,'qualityMethodAndLabelsUnchanged':True,'newModelCalls':0,
        'admissibility':['All124 actual question receipts completed and248 logical backend rows exist exactly once',
          'Every actual WS send has exactly one usage-bearing completion on native event timeline; no unmatched HTTP inference request',
          'Question usage matches native response usage; prewarm and reconnect/control stages included in ledger',
          'Owned execution tree exited; no data/label/scoring mutation'],
        'score':'Call the exact prospectively frozen grounding_score.score function; keep raw executionStatus=failed and separate accounting closure evidence',
        'why':'Hardcoded expected=2*124 was wrong when one thread had2 connect attempts and only1 real question send, without a prewarm send.',
        'notClaimed':'No assertion about unobservable provider-internal work or billing; no inference cost invented for connect attempts.'})

def reconcile():
    assert read('closure-contract.json')['beforeQualityScoring']
    assert read('method-contract.json')['sources']==sources()
    e=read('evaluation.json');assert e['status']=='failed' and e['drainErrorType']=='TimeoutError' and not e.get('errorType') and not e.get('ledgerErrorType')
    calls=e['modelCalls'];assert len(calls)==124 and len(e['rows'])==248
    qids=[q['id'] for q in read('validation.json')['cases']]
    assert Counter(r['id'] for r in e['rows'])==Counter({q:2 for q in qids})
    assert Counter(r['questionId'] for r in calls)==Counter(qids)
    assert all(r['receipt']['status']=='completed' for r in calls)
    ledger=e['ledger'];assert ledger['usageComplete'] and ledger['canonicalHttpResponseRequests']==0
    events=ledger['nativeEvents'];sends=[r for r in events if r.get('event.name')=='codex.websocket_request']
    completions=[r for r in events if r.get('event.kind')=='response.completed' and 'input_token_count' in r]
    assert len(sends)==len(completions)==len(ledger['requests'])==247
    assert sum(r['role']=='question' for r in ledger['requests'])==124
    assert Counter(r['conversation.id'] for r in sends)==Counter(r['conversation.id'] for r in completions)
    # The original ledger already asserted native question usage == receipt usage.
    warm={r['conversationId'] for r in ledger['requests'] if r['role']=='prewarm'}
    absent=[c for c in calls if c['receipt']['threadId'] not in warm];assert len(absent)==1
    thread=absent[0]['receipt']['threadId'];relevant=[r for r in events if r.get('conversation.id')==thread]
    safe=[{k:r.get(k) for k in ['event.name','event.kind','event.timestamp','duration_ms','input_token_count','output_token_count']} for r in relevant]
    assert sum(r.get('event.name')=='codex.websocket_connect' for r in relevant)==2
    assert sum(r.get('event.name')=='codex.websocket_request' for r in relevant)==1
    assert not read('resource-observation.json')['residual'] and not e['bmResidual']
    process=json.loads((WORK/'formal-index/bm/process.json').read_text(encoding='utf-8'));assert process['status']=='exited' and not process['residual']
    save('closure-audit.json',{'at':now(),'rawStatus':e['status'],'rawEvaluationSha256':digest(REPORTS/'evaluation.json'),
        'rawFailure':'drain expected248 response completions; actual247, due absent prewarm send',
        'businessResultsComplete':True,'actualUsageClosed':True,'actualQuestionTurns':124,'logicalRows':248,'actualSends':len(sends),
        'usageCompletions':len(completions),'actualPrewarmTurns':123,'unmatchedObservedSends':0,'httpInferenceRequests':0,
        'threadWithoutPrewarm':{'questionId':absent[0]['questionId'],'callId':absent[0]['id'],'nativeTimeline':safe},
        'allNetworkRequestStages':ledger['allNetworkRequestCount'],'qualityNotYetScored':not (REPORTS/'scored-results.json').exists(),
        'extraModelCalls':0,'providerInternalUsage':'unknown, not zero','scoringAllowedByObservedClosure':True})
    print(json.dumps({'rawStatus':'failed','businessRowsComplete':True,'sends':len(sends),'usageCompletions':len(completions),'prewarm':123,'closure':'matched observed requests; no new calls'}))

def report():
    from grounding_score import score,stats
    closure=read('closure-audit.json');assert closure['scoringAllowedByObservedClosure'] and closure['qualityNotYetScored']
    e=read('evaluation.json');assert digest(REPORTS/'evaluation.json')==closure['rawEvaluationSha256']
    frozen=read('validation-contract.json');assert frozen['scorerSha256']==digest(Path(__file__).with_name('grounding_score.py'))
    assert frozen['corpusSha256']==digest(REPORTS/'corpus.json') and frozen['validationSha256']==digest(REPORTS/'validation.json')
    cases={q['id']:q for q in read('validation.json')['cases']}
    outputs={b:score([r for r in e['rows'] if r['backend']==b],cases) for b in ['hub-native-hybrid','basic-memory-hybrid']}
    save('scored-results.json',outputs)
    ledgers=[read('development-model.json')['ledger'],e['ledger']]
    cost={k:sum(x[k] for x in ledgers) for k in ['responseRequests','prewarmRequests','unusedFinalPrewarmRequests','totalInputTokens','totalOutputTokens','cachedInputTokens','totalTokens','allNetworkRequestCount']}
    cost.update({'modelTurns':sum(len(x['requests'])-x['prewarmRequests'] for x in ledgers),
       'developmentModelTurns':len(read('development-model.json')['calls']),'formalModelTurns':len(e['modelCalls']),
       'formalModelBatchWallMs':e['modelBatchWallMs'],'formalFullWallMs':e['totalMs'],
       'developmentRetrievalWallMs':read('development-retrieval.json')['wallMs'],'developmentModelWallMs':read('development-model.json')['wallMs'],
       'primaryAgentAndLocalEmbeddingTokens':'unknown, not zero','billing':'processed workload including all observed warmup, not invoice',
       'rawDrainTimeoutPreserved':True,'actualUsageClosed':True,'inferenceSendsWithoutUsage':0})
    p=[d for d in next(iter(outputs.values()))['details'] if d['positive']]
    tail={'positive':len(p),'initialNonfirst':sum(d['initialRank'] is None or d['initialRank']>1 for d in p),
       'initialBeyond5':sum(d['initialRank'] is None or d['initialRank']>5 for d in p),
       'finalNonfirst':sum(d['finalRank'] is None or d['finalRank']>1 for d in p),'finalBeyond5':sum(d['finalRank'] is None or d['finalRank']>5 for d in p)}
    tail['retrievalTailDemonstrated']=tail['initialNonfirst']>=6 and tail['initialBeyond5']>=2
    source_audit=[{'id':s['id'],'snapshotUnchanged':digest(s['snapshot'])==s['sha256'],
       'originalUnchanged':Path(s['path']).exists() and digest(s['path'])==s['sha256']} for s in read('real-notes.json')['sources']]
    summary={'at':now(),'evaluationStatus':'failed','rawFailurePreserved':True,'closureAudit':str(REPORTS/'closure-audit.json'),
       'quality':{b:v['quality'] for b,v in outputs.items()},'tailCoverage':tail,'cost':cost,'indexes':e['indexes'],
       'modelCallMs':stats([c['receipt']['durationMs'] for c in e['modelCalls']]),
       'observedRetrievalMs':{b:v['observedRetrievalMs'] for b,v in outputs.items()},'evidenceTokens':next(iter(outputs.values()))['evidenceTokens'],
       'lexicalNonempty':sum(bool(r['retrieval']['lexical']) for r in e['rows'][::2]),'sourceAudit':source_audit,'bmResidual':e['bmResidual'],
       'backendSelected':False,'laterBatchesStarted':False,'limitations':['Raw runner failed during fixed-count drain; observed247 sends/247 usages independently reconciled offline, no rerun.',
       'Shared BM parser representation/common Hub lexical/resolver; native Python vector fixture, not shipping Rust runtime.',
       'Same-family author/judge; source-qualified facts/advice, not end-to-end confirmed decision reuse.',
       '100 constructed correlated negatives;6000 BGE budget exceeds production2000; target-scale hot performance/lifecycle/20tasks/runtime/24h/distribution gates open.']}
    save('summary.json',summary)
    print(json.dumps({k:summary[k] for k in ['quality','tailCoverage','cost','modelCallMs','observedRetrievalMs','evidenceTokens','lexicalNonempty']},ensure_ascii=False))

def audit():
    from grounding_checks import verify_candidate,MARK
    assert read('method-contract.json')['sources']==sources()
    closure=read('closure-audit.json');e=read('evaluation.json');assert closure['scoringAllowedByObservedClosure'] and digest(REPORTS/'evaluation.json')==closure['rawEvaluationSha256']
    by_mid={r['id']:r for r in read('corpus.json')['records']};injections=quotes=0
    for row in e['rows']:
        for m in row['retrieval']['candidates']:
            assert m['project']=='notes' and m['status']=='confirmed';verify_candidate(m,by_mid[m['id']]);injections+=1
        c=row['checked']
        if c['ids']:
            m=next(m for m in row['retrieval']['candidates'] if m['id']==c['ids'][0]);assert any(c['decision']['quote'] in x for x in m['text'].split(MARK));quotes+=1
    calls=e['modelCalls']+read('development-model.json')['calls'];alive=[]
    for call in calls:
        r=call['receipt'];assert r['model']==MODEL and r['effort']==EFFORT and r['toolCalls']==0 and r['ephemeral'] and r['freshEmptyHistory'] and r['explicitRetries']==0
        try:
            p=psutil.Process(r['pid'])
            if p.create_time()==r['createTime'] and p.is_running():alive.append({'pid':p.pid,'createTime':p.create_time()})
        except psutil.NoSuchProcess:pass
    assert not alive and not read('resource-observation.json')['residual']
    production={p:digest(ROOT/p)==h for p,h in read('scope-contract.json')['baseline'].items() if p.startswith('src-tauri/')};assert all(production.values())
    pairs={}
    for r in e['rows']:pairs.setdefault(r['id'],[]).append(r)
    same=sum(v[0]['promptSha256']==v[1]['promptSha256'] for v in pairs.values())
    # Full three-identity credential/disk scan is performed by finish.py after docs.
    save('delivery-verification.json',{'at':now(),'rawStatus':'failed','actualUsageClosed':True,'closureAuditSha256':digest(REPORTS/'closure-audit.json'),
       'injectedCandidatesAudited':injections,'selectedQuotesAudited':quotes,'actualModelCallsAudited':len(calls),'model':MODEL,'effort':EFFORT,
       'toolsAndExplicitRetries':0,'sameWholePromptQuestions':same,'ownedProcessesAlive':alive,'productionSourcesUnchanged':production,
       'vaultWrites':0,'sourcesFrozen':sources(),'credentialScan':'See complete-round.json final three-root scan; not presumed passed here.'})
    print(json.dumps({'injections':injections,'quotes':quotes,'actualCalls':len(calls),'samePrompts':same,'sourceAndProcessChecks':'passed'}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['contract','reconcile','report','audit'])
    {'contract':contract,'reconcile':reconcile,'report':report,'audit':audit}[p.parse_args().phase]()
