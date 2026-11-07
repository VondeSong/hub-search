"""Post-method new synthetic facts; old records retained as distractions."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import random
import re
from connection_support import ROOT,REPORTS,PREVIOUS,read,save,digest
from passage_index import tokenizer

def opaque(prefix,text):
    return prefix+hashlib.sha256(('connection-holdout/'+text).encode()).hexdigest()[:12]

def build():
    method=REPORTS/'method-contract.json'; raw_path=Path(__file__).with_name('connection_new_cases.json')
    assert raw_path.stat().st_mtime_ns>method.stat().st_mtime_ns
    raw=json.loads(raw_path.read_text(encoding='utf-8'))
    previous=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    records=list(previous['records']); ids={r['origin']:opaque('m-',r['origin']) for r in raw['records']}
    for r in raw['records']:
        records.append({'id':ids[r['origin']],'originId':r['origin'],'title':r['title'],
                        'content':r['content'],'project':r['project'],'status':r['status'],
                        'source':'New fictional record after connection method freeze; no personal notes.'})
    by_id={r['id']:r for r in records}; cases=[]
    for q in raw['cases']:
        expected=[ids[q['expectedOrigin']]] if q.get('expectedOrigin') else []
        if expected:
            r=by_id[expected[0]]
            assert r['project']==q['project'] and r['status']=='confirmed' and q['goldSupport'] in r['content']
        cases.append({'id':opaque('q-',q['query']),'query':q['query'],'project':q['project'],
                      'expected':expected,'goldSupport':q.get('goldSupport',''),'category':q['category']})
    assert len(records)==208 and len(cases)==80 and sum(bool(q['expected']) for q in cases)==40
    old=json.loads((ROOT/'qa/memory-selection/corpus.json').read_text(encoding='utf-8'))['queries']
    for folder in ['hbm-00-applicability-20261018','hbm-00-independent-20261018','hbm-00-passages-20261018','hbm-00-latency-20261018']:
        old+=json.loads((ROOT/'artifacts'/folder/'validation.json').read_text(encoding='utf-8'))['cases']
    norm=lambda text:re.sub(r'\W+','',text).lower()
    assert len({norm(q['query']) for q in cases})==80
    assert not {norm(q['query']) for q in cases}&{norm(q['query']) for q in old}
    random.Random(2026101811).shuffle(records); random.Random(2026101812).shuffle(cases)
    save('corpus.json',{'projects':previous['projects'],'records':records,'priorCorpusSha256':digest(PREVIOUS/'corpus.json')})
    save('validation-draft.json',{'cases':cases,'authorship':'Primary agent, same model family; not independent human labels.',
         'methodContractSha256':digest(method),'sourceFixtureSha256':digest(raw_path)})
    tok=tokenizer(); positives=[q for q in cases if q['expected']]
    lengths=[len(tok.encode(by_id[q['expected'][0]]['content'],add_special_tokens=False).ids) for q in positives]
    late=[q['id'] for q in positives if len(tok.encode(by_id[q['expected'][0]]['content'].split(q['goldSupport'])[0],add_special_tokens=False).ids)>=512]
    save('fixture-build.json',{'records':len(records),'questions':80,'positive':40,'negative':40,
         'priorQuestionDuplicates':0,'newFactsAfterMethodFreeze':True,'modelCalls':0,
         'distinctPositiveRecords':len({q['expected'][0] for q in positives}),
         'longestPositiveBodyTokens':max(lengths),'positiveWithSupportAfter512Tokens':len(late),'latePositiveIds':late})
    print(json.dumps(read('fixture-build.json')))

def freeze():
    draft=read('validation-draft.json')
    assert draft['methodContractSha256']==digest(REPORTS/'method-contract.json')
    assert read('validation-audit.json')['status']=='reviewed_before_retrieval'
    save('validation.json',draft)
    save('validation-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),
         'corpusSha256':digest(REPORTS/'corpus.json'),'validationSha256':digest(REPORTS/'validation.json'),
         'methodContractSha256':digest(REPORTS/'method-contract.json'),'fixtureSha256':draft['sourceFixtureSha256'],
         'fixtureBuilderSha256':digest(Path(__file__)),'oneExecutionOnly':True,'postFreezeLabelChanges':False})
    save('scoring-contract.json',{'reporterSha256':digest(Path(__file__).with_name('connection_report.py')),
         'gates':read('method-contract.json')['gates']})
    print('New holdout frozen; no retrieval or model calls before this freeze.')

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('phase',choices=['build','freeze'])
    {'build':build,'freeze':freeze}[p.parse_args().phase]()
