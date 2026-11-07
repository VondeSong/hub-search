"""Prospective source sampling and complete pre-retrieval label freeze."""
import argparse
import hashlib
import json
import random
import re
import subprocess
from pathlib import Path
from grounding_support import *
from passage_index import tokenizer

def sample():
    method=read('method-contract.json');assert method['sources']==sources()
    old=set();old_hashes=set()
    for path in (ROOT/'artifacts').glob('hbm-00-*/real-notes.json'):
        d=json.loads(path.read_text(encoding='utf-8'))
        old.update(Path(s['path']).resolve() for s in d.get('sources',[]) if s.get('path'))
        old_hashes.update(s['sha256'] for s in d.get('sources',[]) if s.get('sha256'))
    records=[];sources_list=[];inventory=[];targets=[];guards=[];tok=tokenizer()
    snapshot=WORK/'real-note-snapshots';snapshot.mkdir(exist_ok=False)
    def add(path,cluster,project='notes',status='confirmed'):
        raw=path.read_bytes();text=raw.decode('utf-8-sig');rel=path.relative_to(VAULT).as_posix()
        mid='m-'+hashlib.sha256(('grounding/'+rel).encode()).hexdigest()[:16]
        dest=snapshot/(mid+'.md');dest.write_bytes(raw)
        s={'id':mid,'path':str(path),'snapshot':str(dest),'sha256':hashlib.sha256(raw).hexdigest(),
           'tokens':len(tok.encode(text,add_special_tokens=False).ids),'characters':len(text),'wholeNote':True}
        r={'id':mid,'originId':rel,'title':path.stem,'project':project,'status':status,'cluster':cluster,'content':text,'source':s}
        sources_list.append(s);records.append(r);return r
    for cluster in ['Areas/结构学','Resources','Areas']:
        r=subprocess.run(['rg','--files',str(VAULT/cluster),'-g','*.md','-g','!AGENTS.md'],capture_output=True,check=True)
        paths=[Path(p) for p in r.stdout.decode('utf-8').splitlines()]
        paths.sort(key=lambda p:hashlib.sha256(('grounding18/'+p.relative_to(VAULT).as_posix()).encode()).hexdigest())
        eligible=[]
        for path in paths:
            if cluster=='Areas' and path.is_relative_to(VAULT/'Areas/结构学'):continue
            if any(x in ['.obsidian','.git','.trash','.basic-memory'] for x in path.parts):continue
            if path.resolve() in old or not 1200<=path.stat().st_size<=60000:continue
            raw=path.read_bytes()
            if hashlib.sha256(raw).hexdigest() in old_hashes:continue
            text=raw.decode('utf-8-sig')
            if not 1200<=len(text)<=18000 or '\x00' in text:continue
            if re.search(r'\b(?:sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.)',text):raise RuntimeError('Possible credential; stop before export')
            eligible.append(path)
        long_paths=[p for p in eligible if len(tok.encode(p.read_bytes().decode('utf-8-sig'),add_special_tokens=False).ids)>1400]
        assert len(eligible)>=20 and len(long_paths)>=4, 'Insufficient prospectively inventoried real sources'
        inventory.append({'cluster':cluster,'eligiblePrefix':len(eligible),'previousSourceOverlap':0})
        selected=long_paths[:4]+[p for p in eligible if p not in long_paths[:4]][:8]
        added=[add(p,cluster) for p in selected]
        long=[r for r in added if r['source']['tokens']>1400]
        assert len(long)>=4
        targets.extend(r['id'] for r in long[:4]);guards.extend((p,cluster) for p in eligible if p not in selected)
    for n,(p,cluster) in enumerate(guards[:8]):add(p,cluster,'other' if n<4 else 'notes','confirmed' if n<4 else ['candidate','superseded','inactive','deleted'][n-4])
    assert len(records)==44 and len(set(targets))==12
    save('real-notes.json',{'records':records,'sources':sources_list,'targetIds':targets,'inventory':inventory,
        'vaultWrites':0,'attachmentsRead':False,'textOnly':True,'oldSourcesExcluded':len(old),
        'authority':'Confirmed denotes frozen source identity, never endorsed user rule/preference/event',
        'methodSha256':digest(REPORTS/'method-contract.json')})
    print(json.dumps({'records':len(records),'targets':targets,'inventory':inventory,
        'notes':[{'id':r['id'],'title':r['title'],'tokens':r['source']['tokens'],'target':r['id'] in targets,'status':r['status'],'project':r['project']} for r in records]},ensure_ascii=False))

def freeze():
    assert read('method-contract.json')['sources']==sources()
    rawpath=WORK/'new-cases.json';assert rawpath.stat().st_mtime_ns>(REPORTS/'method-contract.json').stat().st_mtime_ns
    data=json.loads(rawpath.read_text(encoding='utf-8'));notes=read('real-notes.json');records=notes['records'];by_mid={r['id']:r for r in records};tok=tokenizer()
    cases=data['cases'];positive=negative=late=0;prior=set();norm=lambda s:re.sub(r'\W+','',s).lower()
    for path in (ROOT/'artifacts').glob('hbm-00-*/validation.json'):
        prior.update(norm(q['query']) for q in json.loads(path.read_text(encoding='utf-8')).get('cases',[]))
    for q in cases:
        q['id']='q-'+hashlib.sha256(('grounding/'+q['query']).encode()).hexdigest()[:16];q.setdefault('project','notes')
        assert norm(q['query']) not in prior
        if q['expected']:
            positive+=1;q['evidenceOffsets']=[]
            assert q['evidence'] and q['answerFact'] and q['allCorpusAlternativeReview']
            assert set(q['expected'])=={e['id'] for e in q['evidence']}
            for e in q['evidence']:
                r=by_mid[e['id']];assert r['status']=='confirmed' and r['project']==q['project'] and r['title'] not in q['query']
                assert e['cores'] and all(len(c)>=6 and c in r['content'] for c in e['cores'])
                for c in e['cores']:
                    a=r['content'].index(c);q['evidenceOffsets'].append({'id':r['id'],'start':a,'end':a+len(c),'afterTokens':len(tok.encode(r['content'][:a],add_special_tokens=False).ids)})
            late+=any(e['afterTokens']>=1024 for e in q['evidenceOffsets'])
        else:
            negative+=1;assert not q['evidence'] and q['rationale'] and q['absenceAudit']
    assert positive==24 and negative==100 and len(cases)==124 and late>=12
    assert len({q['id'] for q in cases})==124
    assert set(notes['targetIds']) <= {e['id'] for q in cases for e in q['evidence']}
    random.Random(2026101851).shuffle(records);random.Random(2026101852).shuffle(cases)
    save('corpus.json',{'records':records,'projects':{'notes':'local-source-snapshots','other':'out-of-scope-control'}})
    save('validation.json',{'cases':cases,'author':'Primary Codex agent; same model family as judge; not independent annotation'})
    save('validation-contract.json',{'frozenAt':now(),'corpusSha256':digest(REPORTS/'corpus.json'),'validationSha256':digest(REPORTS/'validation.json'),
        'methodSha256':digest(REPORTS/'method-contract.json'),'scorerSha256':digest(Path(__file__).with_name('grounding_score.py')),
        'positive':positive,'negative':negative,'lateAfter1024':late,'rawCasesSha256':digest(rawpath),'review':data['review'],
        'singleExecution':True,'postFreezeLabelAndMethodChanges':False})
    print(json.dumps({'frozen':True,'positive':positive,'negative':negative,'lateAfter1024':late}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['sample','freeze'])
    {'sample':sample,'freeze':freeze}[p.parse_args().phase]()
