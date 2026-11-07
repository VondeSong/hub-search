"""Freeze author labels and identities before the first validation retrieval."""
import json
import random
import re
from parity_support import *
from passage_index import tokenizer

if __name__=='__main__':
    raw_path=WORK/'new-cases.json'
    assert raw_path.stat().st_mtime_ns > (REPORTS/'method-contract.json').stat().st_mtime_ns
    raw=json.loads(raw_path.read_text(encoding='utf-8'))
    notes=read('real-notes.json'); records=notes['records']; by_id={r['id']:r for r in records}
    cases=raw['cases']; tok=tokenizer(); positive=negative=late=0
    prior=set()
    norm=lambda t:re.sub(r'\W+','',t).lower()
    for path in (ROOT/'artifacts').glob('hbm-00-*/validation.json'):
        prior.update(norm(q['query']) for q in json.loads(path.read_text(encoding='utf-8')).get('cases',[]))
    for q in cases:
        q['id']='q-'+hashlib.sha256(('parity/'+q['query']).encode()).hexdigest()[:16]
        q.setdefault('project','notes')
        assert norm(q['query']) not in prior
        if q['expected']:
            positive+=1
            q['evidenceOffsets']=[]
            for e in q['evidence']:
                r=by_id[e['id']]
                assert e['id'] in q['expected'] and r['status']=='confirmed' and r['project']==q['project']
                assert e['quote'] in r['content'] and all(x in e['quote'] for x in e['required'])
                assert r['title'] not in q['query'], 'Positive repeats exact source title'
                offset=r['content'].index(e['quote'])
                q['evidenceOffsets'].append({'id':r['id'],'start':offset,'end':offset+len(e['quote']),
                    'afterTokens':len(tok.encode(r['content'][:offset],add_special_tokens=False).ids)})
            late+=any(e['afterTokens']>=1024 for e in q['evidenceOffsets'])
        else:
            negative+=1
            assert q['rationale'] and not q['evidence']
    assert positive==24 and negative==100 and len(cases)==124
    assert len({q['id'] for q in cases})==124
    assert {e['id'] for q in cases for e in q['evidence']} >= set(notes['targetIds'])
    assert late>=12, 'Structural tail coverage is insufficient before retrieval'
    random.Random(2026101841).shuffle(records); random.Random(2026101842).shuffle(cases)
    save('corpus.json',{'projects':{'notes':'授权的本地来源快照','other':'未授权的隔离范围'},'records':records})
    save('validation.json',{'cases':cases,'author':'Primary Codex agent; same model family as judge, not independent annotation.'})
    save('validation-contract.json',{'frozenAt':now(),'methodSha256':digest(REPORTS/'method-contract.json'),
        'corpusSha256':digest(REPORTS/'corpus.json'),'validationSha256':digest(REPORTS/'validation.json'),
        'rawCasesSha256':digest(raw_path),'positive':positive,'negative':negative,'supportAfter1024':late,
        'scorerSha256':digest(Path(__file__).with_name('parity_report.py')),'sourceHashAudit':'Original snapshot SHA256 verified; source material not an instruction.',
        'preRetrievalReview':raw['review'],'postFreezeChangesAllowed':False,'oneExecutionOnly':True})
    print(json.dumps({'frozen':True,'records':len(records),'positive':positive,'negative':negative,'supportAfter1024':late}))
