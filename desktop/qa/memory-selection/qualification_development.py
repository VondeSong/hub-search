"""Only retired questions: correctness regression, never holdout acceptance."""
import argparse
import hashlib
import json
import os
import time

from qualification_contract import *
from qualification_evidence import Budget, pack
from qualification_profile import old_index
from grounding_index import headings
from grounding_score import core_match, stats
from passage_index import terms

FAILURES=['q-3ffe9a76214c9e3f','q-23842e29f80e44d8']
TAG='development-v4'

def resolve_old(idx,q,previous,budget):
    r=previous['retrieval']
    hits={mid:idx.passages[pid] for mid,pid in r['bestPassages'].items()}
    qt=set(terms(q['query']));locators={}
    for mid in r['reranked'][:5]:
        # Recover query facets that the semantic hit does not contain. Reusing
        # total overlap here selected another answer summary and lost the very
        # example/subject that identifies the requested source.
        novel=qt-idx.termsets[hits[mid]['id']]
        pids=sorted(idx.by_parent[mid], key=lambda p:(-sum(idx.idf.get(t,0) for t in novel & idx.termsets[p]),
            -sum(idx.idf.get(t,0) for t in qt & idx.termsets[p]),p))
        for pid in pids:
            p=idx.passages[pid]
            if p['end']<=hits[mid]['start'] or p['start']>=hits[mid]['end']:
                locators[mid]={**p,'locatorTerms':{t:idx.idf.get(t,0) for t in novel or qt}};break
    candidates,provenance,receipt=pack(idx.records,r['reranked'],hits,locators,headings,budget,
        {t:idx.idf.get(t,0) for t in qt})
    return {'candidates':candidates,'provenance':provenance,'budget':receipt}

def offline():
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    idx=old_index();budget=Budget()
    cases={q['id']:q for q in read('validation.json',OLD)['cases']}
    rows=[r for r in read('evaluation.json',OLD)['rows'] if r['backend']=='hub-native-hybrid']
    report=[];all_start=time.perf_counter()
    for previous in rows:
        q=cases[previous['id']];began=time.perf_counter()
        resolved=resolve_old(idx,q,previous,budget)
        delivered=any(core_match(q['evidence'],m['id'],m['text']) for m in resolved['candidates'])
        result={'id':q['id'],'positive':bool(q['expected']),'coreDelivered':delivered,
            'hostMs':(time.perf_counter()-began)*1000,**resolved}
        save(TAG+'-'+q['id']+'.json',result);report.append(result)
    positive=[x for x in report if x['positive']]
    checks=[]
    # These fixtures test boundaries that broke the real consumer, including
    # continuation after a blank line and clause-level negation in long text.
    from qualification_evidence import proposals
    text='作者说明：这是比喻。\n\n遇到复杂问题时先停一下。\n\n不能把简化模型当成事实。下一步应回到原始证据。\n\n后记。'
    a=text.index('遇到');hit={'start':a,'end':a+len('遇到复杂问题时先停一下。')}
    ranges,_=proposals(text,hit)[0]
    delivered=''.join(text[a:b] for a,b in ranges)
    assert '作者说明：这是比喻。' in delivered and '不能把简化模型当成事实。' in delivered and '下一步应回到原始证据。' in delivered
    checks.append('paragraph+previous+following-two-sentences retained exactly')
    summary={'at':now(),'oldOnly':True,'newSourcesRead':False,'modelCalls':0,'n':len(report),
        'oldPositive':len(positive),'coreDelivered':sum(x['coreDelivered'] for x in positive),
        'knownFailures':{qid:{k:next(x for x in report if x['id']==qid)[k] for k in ['coreDelivered','hostMs','budget']} for qid in FAILURES},
        'packingMs':stats([x['hostMs'] for x in report]),'wallMs':(time.perf_counter()-all_start)*1000,
        'estimatedTokens':stats([x['budget']['estimatedTextTokens'] for x in report]),'checks':checks,
        'budgetGate':'Estimated with25%reserve, exact Sol tokenizer unavailable in local tiktoken; not strict formal acceptance',
        'sources':{n:digest(Path(__file__).with_name(n)) for n in ['qualification_evidence.py','qualification_development.py']}}
    save(TAG+'-evidence.json',summary);print(json.dumps(summary),flush=True)

def model():
    from qualification_accounting import configure_transport,finish
    from grounding_policy import POLICY,SCHEMA,validate_decisions
    native=configure_transport();wire=None;calls=[];rows=[]
    cases={q['id']:q for q in read('validation.json',OLD)['cases']}
    save(TAG+'-model-contract.json',{'at':now(),'questions':FAILURES,'maxCalls':2,
        'model':MODEL,'effort':EFFORT,'purpose':'Retired failure regression plus live actual-accounting closure. NOT new acceptance.',
        'budgetGate':'local estimate with25%reserve only','sourceSha256':digest(__file__)})
    try:
        wire=native.Wire(WORK/(TAG+'-server'),http=False)
        for i,qid in enumerate(FAILURES,1):
            q=cases[qid];found=read(TAG+'-'+qid+'.json')
            task={'id':qid,'project':q['project'],'question':q['query'],'candidateIds':[c['id'] for c in found['candidates']]}
            prompt=POLICY+'\n本轮来源投影说明：来源原文均在text内，技术偏移与哈希由宿主核对。contextIncomplete=true表示上下文缩减，不能补推缺失事实。\n待核验数据：\n'+json.dumps({'memories':found['candidates'],'tasks':[task]},ensure_ascii=False,separators=(',',':'))
            began=time.time_ns();answer,receipt=wire.app_call(prompt,SCHEMA,WORK/f'{TAG}-call-{i}');ended=time.time_ns()
            call={'id':f'dev-{i}','questionId':qid,'startUnixNs':began,'endUnixNs':ended,'receipt':receipt};calls.append(call)
            checked=validate_decisions(answer,[task],found['candidates'])[0]
            correct=bool(checked['ids']) and core_match(q['evidence'],checked['ids'][0],checked['decision']['quote'])
            rows.append({'id':qid,'checked':checked,'correct':correct,'receipt':receipt,'materialBudget':found['budget']})
            save(f'{TAG}-model-row-{i}.json',rows[-1])
            print(json.dumps({'oldFailure':i,'correct':correct,'modelMs':receipt['durationMs']}),flush=True)
    finally:
        if wire:
            closure=finish(wire,calls,native)
            save(TAG+'-model.json',{'at':now(),'rows':rows,'calls':calls,'closure':closure,
                'secretScan':native.secret_scan(),'isNewAcceptance':False})
    print(json.dumps({'oldFailureCorrect':sum(r['correct'] for r in rows),'n':len(rows),
        'closureStatus':closure['status'],'actualRequests':closure['ledger']['responseRequests'],
        'prewarm':closure['ledger']['prewarmRequests'],'allTokens':closure['ledger']['totalTokens']}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['offline','model']);a=p.parse_args()
    {'offline':offline,'model':model}[a.phase]()
