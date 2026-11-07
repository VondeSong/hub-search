"""Materialize a new holdout only after the algorithm/model method is frozen."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re

from passage_support import ROOT,WORK,REPORTS,PREVIOUS,save,read,digest


def opaque(prefix,value):
    return prefix+hashlib.sha256(value.encode()).hexdigest()[:12]


def build():
    method_path=REPORTS/'method-contract.json'
    fixed=read('method-contract.json')
    raw_path=Path(__file__).with_name('passage_new_cases.json')
    assert raw_path.stat().st_mtime_ns>method_path.stat().st_mtime_ns
    raw=json.loads(raw_path.read_text(encoding='utf-8'))
    previous=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    records=list(previous['records'])
    by_origin={}
    for item in raw['records']:
        ident=opaque('m-','passage-holdout/'+item['origin'])
        records.append({'id':ident,'originId':item['origin'],'project':item['project'],
                        'title':item['title'],'content':item['content'],'status':item['status'],
                        'source':'New fictional working notes authored after method freeze; not personal-library data'})
        by_origin[item['origin']]=ident
    by_id={r['id']:r for r in records}
    cases=[]
    for q in raw['cases']:
        expected=[by_origin[q['expectedOrigin']]] if q.get('expectedOrigin') else []
        if expected:
            record=by_id[expected[0]]
            assert record['status']=='confirmed' and record['project']==q['project']
            assert q['goldSupport'] in record['content']
        cases.append({'id':opaque('q-','passage-holdout/'+q['query']),'project':q['project'],
                      'query':q['query'],'expected':expected,'goldSupport':q.get('goldSupport',''),
                      'category':q['category']})
    assert len(cases)==80 and sum(bool(q['expected']) for q in cases)==40
    old=json.loads((ROOT/'qa/memory-selection/corpus.json').read_text(encoding='utf-8'))['queries']
    old+=json.loads((ROOT/'artifacts/hbm-00-applicability-20261018/validation.json').read_text(encoding='utf-8'))['cases']
    old+=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    normal=lambda value:re.sub(r'\W+','',value).lower()
    assert len({normal(q['query']) for q in cases})==80
    assert not {normal(q['query']) for q in cases}&{normal(q['query']) for q in old}
    random.Random(2026101805).shuffle(cases)
    random.Random(2026101806).shuffle(records)
    save('corpus.json',{'format':'hub-hbm-passage-corpus-v1','projects':previous['projects'],
                         'records':records,'priorCorpusSha256':digest(PREVIOUS/'corpus.json'),
                         'sourceScope':'Retained fictional development sources as distractors plus entirely new post-method working facts, no personal library.'})
    save('validation-draft.json',{'format':'hub-hbm-passage-holdout-v1','cases':cases,
        'author':'Primary GPT-6.1 Sol agent, authored after method freeze; not blind human labels.',
        'methodContractSha256':digest(method_path),'sourceFixtureSha256':digest(raw_path)})
    save('fixture-build.json',{'records':len(records),'questions':80,'positive':40,'negative':40,
        'duplicatesWithAllPriorQuestions':0,'sourceFixtureSha256':digest(raw_path),
        'methodFrozenBeforeFixtureAuthored':True})
    print(json.dumps({'records':len(records),'positive':40,'negative':40,'priorQuestionDuplicates':0}))


def freeze():
    draft=read('validation-draft.json')
    assert draft['methodContractSha256']==digest(REPORTS/'method-contract.json')
    save('validation.json',draft)
    save('validation-audit.json',{'status':'audited_before_first_retrieval','questions':80,
        'positive':40,'negative':40,'postFreezeEditsAllowed':False,
        'audit':'Primary agent read each new note and both answerable/missing-fact questions. No independent human labels; all data synthetic.',
        'longRecords':'Variable topics and formats, later facts, close identifiers and old-source distractions; no required answer is added to a judge prompt.'})
    save('validation-contract.json',{'format':'hub-hbm-passage-holdout-freeze-v1',
        'corpusSha256':digest(REPORTS/'corpus.json'),'validationSha256':digest(REPORTS/'validation.json'),
        'methodContractSha256':digest(REPORTS/'method-contract.json'),'positive':40,'negative':40,
        'fixtureSourceSha256':draft['sourceFixtureSha256'],
        'fixtureRunnerSha256':digest(Path(__file__)),'tuningAllowed':False,'fullRunLimit':1})
    save('scoring-contract.json',{'reporterSha256':digest(Path(__file__).with_name('passage_report.py')),
        'rubric':'Frozen candidate top-five and final selected recall >=90%, zero no-answer false selections, exact membership/source checks; all failures retained.',
        'frozenBeforeFirstRetrieval':True})
    print('New holdout, labels and scoring source frozen; one execution permitted')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['build','freeze'])
    args=parser.parse_args()
    {'build':build,'freeze':freeze}[args.phase]()
