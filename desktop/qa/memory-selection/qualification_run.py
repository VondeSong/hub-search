"""Bounded common-flow qualification, before operational backend comparison.

Reference retrieval uses actual Hub Tantivy plus independent Python BGE vectors.
It does NOT establish a shipping Rust embedding backend or a BM comparison.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import random
import re
import sqlite3
import subprocess
import time
from pathlib import Path

import sqlite_vec
from qualification_contract import *
from qualification_evidence import Budget,pack
from qualification_accounting import configure_transport,finish
import grounding_index as prior
from grounding_policy import POLICY,SCHEMA,validate_decisions
from grounding_score import score,stats
from passage_index import terms,tokenizer

POLICY=POLICY+'\n本轮来源投影说明：来源原文均在text内，技术偏移与哈希由宿主核对。contextIncomplete=true表示上下文缩减，不能补推缺失事实。'
FILES=['qualification_run.py','qualification_evidence.py','qualification_accounting.py',
    'qualification_contract.py','qualification_development.py',
    'grounding_index.py','grounding_policy.py','grounding_score.py','parity_index.py','passage_index.py',
    'applicability_policy.py','accounting_transport.py','accounting_support.py','connection_transport.py',
    'connection_support.py','latency_transport.py','latency_reuse.py','latency_support.py','passage_model.py','run.py']

def code_identity():
    return {n:digest(Path(__file__).with_name(n)) for n in FILES}

def method_name():
    return 'new-method-contract-v2.json' if (REPORTS/'new-method-contract-v2.json').exists() else 'new-method-contract.json'

class ReferenceIndex(prior.Index):
    def __init__(self,corpus):
        prior.base.WORK=WORK
        super().__init__(corpus,'new-quality-index')
        self.budget=Budget()

    def prepare_reference_vectors(self):
        from fastembed import TextEmbedding
        start=time.perf_counter()
        self.embedding=TextEmbedding(model_name='BAAI/bge-small-zh-v1.5',threads=2,
            cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True,enable_cpu_mem_arena=False)
        self.native=sqlite3.connect(self.root/'native.sqlite3')
        self.native.enable_load_extension(True);sqlite_vec.load(self.native);self.native.enable_load_extension(False)
        self.native.executescript('CREATE TABLE manifest(cid INTEGER PRIMARY KEY,pid TEXT,kind TEXT,project TEXT); CREATE VIRTUAL TABLE vectors USING vec0(embedding float[512]);')
        ids=sorted(self.passages)
        vectors=self.embedding.embed([self.passages[i]['text'] for i in ids],batch_size=64)
        for cid,(pid,v) in enumerate(zip(ids,vectors,strict=True),1):
            p=self.passages[pid]
            self.native.execute('INSERT INTO manifest VALUES(?,?,?,?)',(cid,pid,'entity',p['project']))
            self.native.execute('INSERT INTO vectors(rowid,embedding) VALUES(?,?)',(cid,sqlite_vec.serialize_float32(self.normalized(v))))
        self.native.commit()
        return {'inputs':len(ids),'ms':(time.perf_counter()-start)*1000,
            'kind':'independent paragraph representation, entity-only; no BM parser/vector copy; Python prototype NOT Rust runtime'}

    def resolve(self,query,ranked,passage_order):
        start=time.perf_counter()
        original=super().resolve(query,ranked,passage_order)
        hits={mid:self.passages[pid] for mid,pid in original['bestPassages'].items()}
        qt=set(terms(query));locators={}
        for mid in original['reranked'][:5]:
            novel=qt-self.termsets[hits[mid]['id']]
            pids=sorted(self.by_parent[mid],key=lambda p:(-sum(self.idf.get(t,0) for t in novel & self.termsets[p]),
                -sum(self.idf.get(t,0) for t in qt & self.termsets[p]),p))
            for pid in pids:
                p=self.passages[pid]
                if p['end']<=hits[mid]['start'] or p['start']>=hits[mid]['end']:
                    locators[mid]={**p,'locatorTerms':{t:self.idf.get(t,0) for t in novel or qt}};break
        c,a,budget=pack(self.records,original['reranked'],hits,locators,prior.headings,self.budget,{t:self.idf.get(t,0) for t in qt})
        return {**original,'candidates':c,'provenance':a,'materialBudget':budget,
            'memoryBgeTokens':len(self.tok.encode(json.dumps(c,ensure_ascii=False),add_special_tokens=False).ids),
            'observedResolutionMs':(time.perf_counter()-start)*1000}

def freeze_method():
    assert read('development-v4-evidence.json')['coreDelivered']==24
    assert read('development-v4-model.json')['closure']['postExitReconciled']
    target='new-method-contract-v2.json' if (REPORTS/'new-method-contract.json').exists() else 'new-method-contract.json'
    save(target,{'at':now(),'sourceIdentity':code_identity(),'model':MODEL,'effort':EFFORT,
        'preAuthoringCorrection':read('sampling-failure.json') if target.endswith('-v2.json') else None,
        'scopeSha256':digest(REPORTS/'scope-contract.json'),'positive':40,'negative':100,
        'qualityComparator':'Common-flow gate on actual Hub lexical + independent entity-only paragraph vector reference. BM/Rust-operational comparison explicitly follows; no backend superiority claim.',
        'retainedReranker':'Original all-pairs bge-reranker-v2-m3-int8,2threads,batch8. Rejected bucketing NOT used.',
        'budget':'max(o200k_base,cl100k_base)<=1500 including all5 source projections,25% margin to2000; Sol exact count unverified. Estimated-budget experimental result only.',
        'sourceSelection':{'groups':['Areas/结构学','Resources'],'perGroup':{'longTargets':10,'otherEligibleDistractors':26},
            'guards':8,'totalNotes':80,'order':'sha256 qualification18/relative-path; exclude all previous frozen paths AND byte hashes',
            'limits':'1200..18000 Unicode chars,1200..60000bytes; target>=1400BGE tokens; no external attachments',
            'failure':'If inventory inadequate stop before questions; no outcome-based replacement. No retrieval until all140 labels frozen.'},
        'sampleDifficulty':'40 fact questions from20 sources, at least12 support after1024BGE; initial RRF rank6..20>=8 measured AFTER freeze; inadequate coverage is inconclusive, never replace questions using ranks.',
        'annotation':'Same primary Codex author and Sol judge family, no independent human/vendor labels. Full-source exact-span audit plus alternative-source audit documented, semantic ambiguity stays failure.',
        'gates':read('scope-contract.json')['acceptance']['gates'],
        'stopLoss':read('scope-contract.json')['acceptance']['stopLoss'],
        'packages':{n:importlib.metadata.version(n) for n in ['tiktoken','fastembed','onnxruntime','sqlite-vec','tokenizers']},
        'weights':read('method-contract.json',OLD)['pinnedCachedModelFiles'],
        'newBodiesOrQuestionsReadByAuthor':False,'modelCallsMax':140,'formalExecutions':1})
    print('New common-flow method frozen before new source sampling/question authoring.')

def sample():
    assert read(method_name())['sourceIdentity']==code_identity()
    vault=Path('D:/03_Resources/Software/Apps/Obsidian/OS')
    old_paths=set();old_hashes=set()
    for f in (ROOT/'artifacts').glob('hbm-00-*/real-notes.json'):
        if f.parent==REPORTS:continue
        d=json.loads(f.read_text(encoding='utf-8'))
        old_paths.update(Path(s['path']).resolve() for s in d.get('sources',[]) if s.get('path'))
        old_hashes.update(s['sha256'] for s in d.get('sources',[]) if s.get('sha256'))
    tok=tokenizer();records=[];sources=[];targets=[];spares=[];inventory=[]
    snap=WORK/'new-source-snapshots';snap.mkdir(exist_ok=True)
    assert not any(snap.iterdir()), 'Never mix a partial sample or replace already authored sources'
    def add(path,group,project='notes',status='confirmed'):
        raw=path.read_bytes();text=raw.decode('utf-8-sig');rel=path.relative_to(vault).as_posix()
        mid='m-'+hashlib.sha256(('qualification/'+rel).encode()).hexdigest()[:16]
        copy=snap/(mid+'.md');copy.write_bytes(raw)
        s={'id':mid,'path':str(path),'snapshot':str(copy),'sha256':hashlib.sha256(raw).hexdigest(),
            'characters':len(text),'tokens':len(tok.encode(text,add_special_tokens=False).ids)}
        r={'id':mid,'originId':rel,'title':path.stem,'cluster':group,'project':project,'status':status,'content':text,'source':s}
        records.append(r);sources.append(s);return r
    for group in ['Areas/结构学','Resources']:
        cmd=subprocess.run(['rg','--files',str(vault/group),'-g','*.md','-g','!AGENTS.md'],capture_output=True,check=True)
        paths=[Path(p) for p in cmd.stdout.decode('utf-8').splitlines()]
        paths.sort(key=lambda p:hashlib.sha256(('qualification18/'+p.relative_to(vault).as_posix()).encode()).hexdigest())
        eligible=[]
        for path in paths:
            if any(x in ['.obsidian','.git','.trash','.basic-memory'] for x in path.parts):continue
            if path.resolve() in old_paths or not 1200<=path.stat().st_size<=60000:continue
            raw=path.read_bytes()
            if hashlib.sha256(raw).hexdigest() in old_hashes:continue
            text=raw.decode('utf-8-sig')
            if not 1200<=len(text)<=18000 or '\x00' in text:continue
            if re.search(r'\b(?:sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.)',text):raise RuntimeError('Potential credential; stop export')
            eligible.append((path,len(tok.encode(text,add_special_tokens=False).ids)))
        long=[p for p,n in eligible if n>=1400]
        inventory.append({'group':group,'eligible':len(eligible),'long':len(long)})
        assert len(eligible)>=36 and len(long)>=10, 'Frozen inventory inadequate, do not improvise new pool'
        selected=long[:10]+[p for p,n in eligible if p not in long[:10]][:26]
        for i,path in enumerate(selected):
            r=add(path,group)
            if i<10:targets.append(r['id'])
        spares.extend((p,group) for p,n in eligible if p not in selected)
    assert len(spares)>=8, 'Insufficient global guards'
    for i,(p,g) in enumerate(spares[:8]):add(p,g,'other' if i<4 else 'notes','confirmed' if i<4 else ['candidate','superseded','inactive','deleted'][i-4])
    assert len(records)==80 and len(targets)==20
    save('real-notes.json',{'records':records,'sources':sources,'targetIds':targets,'inventory':inventory,
        'oldPathsExcluded':len(old_paths),'vaultWrites':0,'attachmentsRead':False,'textOnly':True,
        'annotationStatus':'Question authoring not started; machine eligibility read before sampling, author sees only after method freeze'})
    print(json.dumps({'records':80,'targets':[{'id':r['id'],'title':r['title'],'tokens':r['source']['tokens']} for r in records if r['id'] in targets],'inventory':inventory},ensure_ascii=False),flush=True)

def freeze_cases():
    assert read(method_name())['sourceIdentity']==code_identity()
    notes=read('real-notes.json');by_id={r['id']:r for r in notes['records']}
    data=json.loads((WORK/'new-cases.json').read_text(encoding='utf-8'));cases=data['cases'];tok=tokenizer()
    prior_queries=set()
    norm=lambda s:re.sub(r'\W+','',s).lower()
    for f in (ROOT/'artifacts').glob('hbm-00-*/validation.json'):
        prior_queries.update(norm(q['query']) for q in json.loads(f.read_text(encoding='utf-8')).get('cases',[]))
    positives=[];negatives=[];late=0
    for q in cases:
        q['id']='q-'+hashlib.sha256(('qualification/'+q['query']).encode()).hexdigest()[:16]
        q.setdefault('project','notes');assert norm(q['query']) not in prior_queries
        if q['expected']:
            positives.append(q);q['evidenceOffsets']=[]
            assert set(q['expected'])=={e['id'] for e in q['evidence']}
            for e in q['evidence']:
                r=by_id[e['id']];assert r['status']=='confirmed' and r['project']==q['project'] and r['title'] not in q['query']
                for core in e['cores']:
                    assert len(core)>=6 and core in r['content']
                    a=r['content'].index(core);q['evidenceOffsets'].append({'id':r['id'],'start':a,'end':a+len(core),
                        'afterTokens':len(tok.encode(r['content'][:a],add_special_tokens=False).ids)})
            late+=any(e['afterTokens']>=1024 for e in q['evidenceOffsets'])
        else:
            negatives.append(q);assert q['rationale'] and q['absenceAudit'] and not q['evidence']
    assert len(positives)==40 and len(negatives)==100 and late>=12 and len({q['id'] for q in cases})==140
    from collections import Counter
    assert Counter(q['category'] for q in negatives)==read('scope-contract.json')['acceptance']['negativeCategories']
    random.Random(2026101871).shuffle(cases);random.Random(2026101872).shuffle(notes['records'])
    save('corpus.json',{'records':notes['records'],'projects':{'notes':'读书','other':'读书'},
        'projectIdentity':'Same display name, distinct stable scope IDs; never scope by display string'})
    save('validation.json',{'cases':cases,'annotation':data['annotation'],'review':data['review']})
    save('validation-contract.json',{'at':now(),'corpusSha256':digest(REPORTS/'corpus.json'),
        'validationSha256':digest(REPORTS/'validation.json'),'methodSha256':digest(REPORTS/method_name()),
        'sources':code_identity(),'positive':40,'negative':100,'late':late,'retrievalNotYetRun':True})
    print(json.dumps({'frozenQuestions':140,'positive':40,'negative':100,'longTailFacts':late}),flush=True)

def evaluate():
    assert read('validation-contract.json')['sources']==code_identity()
    frozen=read('validation-contract.json')
    assert frozen['corpusSha256']==digest(REPORTS/'corpus.json') and frozen['validationSha256']==digest(REPORTS/'validation.json')
    save('execution-start.json',{'at':now(),'sources':code_identity(),'number':1})
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    result={'status':'starting','rows':[],'modelCalls':[],'startedAt':now()};index=wire=None;began=time.perf_counter();native=configure_transport()
    try:
        index=ReferenceIndex(read('corpus.json'));result['vectorPreparation']=index.prepare_reference_vectors()
        questions=read('validation.json')['cases'];harness=read('native-harness.json',OLD)
        lexical=index.native_lexical(questions,harness,'qualification')
        result['lexicalPreparationMs']=index.lexical_receipt['wallMs']
        wire=native.Wire(WORK/'new-quality-server',http=False)
        for i,q in enumerate(questions,1):
            found=index.retrieve(q,lexical[q['id']],'hub-native-hybrid')
            task={'id':q['id'],'project':q['project'],'question':q['query'],'candidateIds':[m['id'] for m in found['candidates']]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps({'memories':found['candidates'],'tasks':[task]},ensure_ascii=False,separators=(',',':'))
            start=time.time_ns();answer,receipt=wire.app_call(prompt,SCHEMA,WORK/f'new-call-{i:03}');end=time.time_ns()
            result['modelCalls'].append({'id':f'new-{i:03}','questionId':q['id'],'startUnixNs':start,'endUnixNs':end,'receipt':receipt})
            checked=validate_decisions(answer,[task],found['candidates'])[0]
            row={'id':q['id'],'backend':'common-reference','retrieval':found,'checked':checked,'receipt':receipt}
            save(f'new-row-{i:03}.json',row);result['rows'].append(row)
            print(json.dumps({'completed':i,'total':140}),flush=True)
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__,'error':str(error)[:300]})
        raise
    finally:
        if wire:
            try:result['closure']=finish(wire,result['modelCalls'],native)
            except BaseException as error:
                result['closure']={'status':'failed','errorType':type(error).__name__};wire.close()
        if index:index.close()
        result.update({'finishedAt':now(),'totalWallMs':(time.perf_counter()-began)*1000})
        save('evaluation.json',result)
    report()

def interval(k,n):
    def cdf(p,j):return sum(math.comb(n,i)*p**i*(1-p)**(n-i) for i in range(j+1))
    def solve(target,j):
        lo,hi=0.,1.
        for _ in range(70):
            mid=(lo+hi)/2
            if cdf(mid,j)>target:lo=mid
            else:hi=mid
        return (lo+hi)/2
    return [0. if k==0 else solve(.975,k-1),1. if k==n else solve(.025,k)]

def report():
    e=read('evaluation.json');cases={q['id']:q for q in read('validation.json')['cases']}
    if len(e['rows'])!=140 or e['status']!='completed':
        save('incomplete-report.json',{'at':now(),'questionsCompleted':len(e['rows']),'planned':140,
            'qualityPassed':False,'evaluationStatus':e['status'],'closure':e.get('closure'),'errorType':e.get('errorType')})
        return
    scored=score(e['rows'],cases);positive=[d for d in scored['details'] if d['positive']]
    tail=sum(d['initialRank'] is not None and 6<=d['initialRank']<=20 for d in positive)
    quality=scored['quality'];quality['exactTwoSided95RecallInterval']=interval(quality['selectedCorrect'],40)
    summary={'at':now(),'quality':quality,'rank6to20Count':tail,'tailCoveragePassed':tail>=8,
        'materialBudgetExactVerified':False,'budget':'local max encoders<=1500,25%reserve; estimated formal-limit experiment only',
        'localRetrievalMs':scored['observedRetrievalMs'],'modelMs':stats([c['receipt']['durationMs'] for c in e['modelCalls']]),
        'totalWallMs':e['totalWallMs'],'closure':e.get('closure'),'backendComparison':False,'backendSelected':False,
        'laterBatchesStarted':False,'next':'At most one further general quality repair/new frozen retest, then operational backend gates; unverified items remain open.'}
    save('scored-results.json',scored);save('summary.json',summary)
    print(json.dumps({k:summary[k] for k in ['quality','rank6to20Count','tailCoveragePassed','modelMs']}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['freeze-method','sample','freeze-cases','evaluate','report'])
    {'freeze-method':freeze_method,'sample':sample,'freeze-cases':freeze_cases,'evaluate':evaluate,'report':report}[p.parse_args().phase]()
