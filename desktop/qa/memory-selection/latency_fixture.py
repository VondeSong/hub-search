"""New facts are authored only after transport selection; retain all old distractions."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re

from latency_support import ROOT, REPORTS, PREVIOUS, save, read, digest


def opaque(prefix, text):
    return prefix+hashlib.sha256(('latency-holdout/'+text).encode()).hexdigest()[:12]


def build():
    method=REPORTS/'method-contract.json'
    raw_path=Path(__file__).with_name('latency_new_cases.json')
    assert raw_path.stat().st_mtime_ns>method.stat().st_mtime_ns
    raw=json.loads(raw_path.read_text(encoding='utf-8'))
    previous=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    records=list(previous['records'])
    ids={r['origin']:opaque('m-',r['origin']) for r in raw['records']}
    for r in raw['records']:
        records.append({'id':ids[r['origin']],'originId':r['origin'],'title':r['title'],
            'content':r['content'],'status':r['status'],'project':r['project'],
            'source':'New fictional notes authored after latency method freeze, not personal-library records.'})
    by_id={r['id']:r for r in records}
    cases=[]
    for q in raw['cases']:
        expected=[ids[q['expectedOrigin']]] if q.get('expectedOrigin') else []
        if expected:
            r=by_id[expected[0]]
            assert r['project']==q['project'] and r['status']=='confirmed' and q['goldSupport'] in r['content']
        cases.append({'id':opaque('q-',q['query']),'query':q['query'],'project':q['project'],
                      'expected':expected,'goldSupport':q.get('goldSupport',''),'category':q['category']})
    assert len(cases)==80 and sum(bool(q['expected']) for q in cases)==40
    old=json.loads((ROOT/'qa/memory-selection/corpus.json').read_text(encoding='utf-8'))['queries']
    for name in ['hbm-00-applicability-20261018','hbm-00-independent-20261018','hbm-00-passages-20261018']:
        old+=json.loads((ROOT/'artifacts'/name/'validation.json').read_text(encoding='utf-8'))['cases']
    norm=lambda t:re.sub(r'\W+','',t).lower()
    assert len({norm(q['query']) for q in cases})==80
    assert not {norm(q['query']) for q in cases}&{norm(q['query']) for q in old}
    random.Random(2026101807).shuffle(cases)
    random.Random(2026101808).shuffle(records)
    save('corpus.json',{'projects':previous['projects'],'records':records,
                       'priorCorpusSha256':digest(PREVIOUS/'corpus.json')})
    save('validation-draft.json',{'cases':cases,'author':'Primary agent, same model family, not independent human labels.',
        'methodContractSha256':digest(method),'sourceFixtureSha256':digest(raw_path)})
    save('fixture-build.json',{'records':len(records),'questions':80,'positive':40,'negative':40,
        'priorQuestionDuplicates':0,'newFactsAfterMethodFreeze':True})
    print(json.dumps({'records':len(records),'questions':80,'priorQuestionDuplicates':0}))


def freeze():
    draft=read('validation-draft.json')
    assert draft['methodContractSha256']==digest(REPORTS/'method-contract.json')
    save('validation.json',draft)
    save('validation-contract.json',{'corpusSha256':digest(REPORTS/'corpus.json'),
        'validationSha256':digest(REPORTS/'validation.json'),
        'methodContractSha256':digest(REPORTS/'method-contract.json'),
        'fixtureSha256':draft['sourceFixtureSha256'],'fixtureBuilderSha256':digest(Path(__file__)),
        'oneExecutionOnly':True,'postFreezeLabelChanges':False})
    save('scoring-contract.json',{'reporterSha256':digest(Path(__file__).with_name('latency_report.py')),
        'gates':read('scope-contract.json')['validation']['gates']})
    save('validation-audit.json',{'status':'audited_before_first_retrieval','questions':80,
        'audit':'Primary agent inspected all facts and answerable/unsupported attributes before freeze; synthetic, not human labels.',
        'limitations':'40 positive questions correspond to 20 new records; same model family, no independent vendor or real private-library scale.'})
    print('New questions, labels and scoring frozen; one formal execution only.')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('phase',choices=['build','freeze'])
    {'build':build,'freeze':freeze}[p.parse_args().phase]()
