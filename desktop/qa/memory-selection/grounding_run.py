"""Bounded HBM-00 development, freeze and one prospective evaluation."""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
import psutil
import sqlite_vec

from grounding_support import *
from grounding_policy import POLICY,SCHEMA,validate_decisions

OLD=ROOT/'artifacts/hbm-00-parity-20261018c'

def register():
    WORK.mkdir(parents=True,exist_ok=False)
    for d in [HOME,WORK/'tmp',WORK/'shared-cwd']:d.mkdir()
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    save('scope-contract.json',{'registeredAt':now(),'request':'Repair common query, evidence clipping and source identity; new holdout; no other batches',
        'owner':'HBM-00 isolated QA; no production or vault writes','root':str(ROOT),'work':str(WORK),'reports':str(REPORTS),
        'method':{'lexical':'Quoted explicit OR terms through unchanged Hub production Tantivy/EvidenceReader',
          'representation':'Same 256/32 BGE Chinese passage representation; BM parser shared; vectors independently computed',
          'retrieval':'Both raw legs50; RRF60 parent20; full-parent lexical recovery2 plus raw2 per parent; common cached BGE m3 int8 cross encoder; best5',
          'evidence':'Exact original paragraph or leading qualification plus hit neighborhood; 550-token window +100-token source lead, source origin/headings/hashes/offsets; JSON<=6000 BGE tokens; no candidate dropping',
          'judgement':'Sol/xhigh ephemeral empty history, no tools, baseline transport unchanged; dedup identical whole prompt per question',
          'scorer':'Before retrieval freeze all acceptable source/core spans found in full-corpus audit; exact quote contains one core. Also source-ID and evidence-delivery rates. No posthoc alternative expansion'},
        'gates':{'candidateRecallAt5':.90,'selectedRecall':.90,'selectedPrecision':.80,'negativeFalseSelections':0,'scopeStateViolations':0,'invalidDecisions':0},
        'coverage':{'positive':24,'negative':100,'targets':12,'supportAfter1024':12,'oldSourceReuse':False,
                    'retrievalTail':'Report initial RRF and final reranked ranks separately; >=6 nonfirst and >=2 beyond5 in initial RRF, otherwise challenge coverage inconclusive, no extra tune/run'},
        'budget':{'formalExecutions':1,'formalModelCallsMax':248,'developmentModelCallsMax':4,'bmInitialReadinessSeconds':900,
                  'explicitRepairSecondsPerProject':900,'nativeTestSeconds':600,'newBuilds':0,'ownedDiskMiB':600},
        'development':'Only previous frozen data and generic fixtures before method freeze; old score is a regression diagnostic, not holdout improvement',
        'newData':{'clusters':['Areas/结构学','Resources','Areas excluding结构学'],'characters':[1200,18000],
                   'pathOrder':'sha256 grounding18/relative-path; first4 >1400tokens then first8 others','selectedPerCluster':12,'guards':8,'excludeAllPreviousFrozenSourcePathsAndHashes':True,
                   'inventoryOnlyAmendment':'Two earlier narrow-pool failures before any questions; eligible disjoint pools59/72/31 measured without author seeing source content; unchanged development reused and costs counted once'},
        'lifecycle':'Keep all failures/costs; close owned pid/createTime processes; no recursive deletion; no plaintext auth copy',
        'stop':'After one new frozen evaluation and docs. Backend remains unselected until remaining HBM-00 gates. No latency/provider work or later batches',
        'ci':'No Git root or remote; reuse exact one collected native opt-in test and verify executable hash; no rebuild/full suite',
        'baseline':{p:digest(ROOT/p) for p in ['docs/INSIGHTS_IMPLEMENTATION_PLAN.md','docs/AGENTS_ROADMAP.md','qa/memory-selection/README.md','src-tauri/src/agent_work/memory_selection_tests.rs','src-tauri/src/search_index.rs']},
        'skills':{p:digest(Path('C:/Users/yongs/.codex/skills')/p) for p in ['project-steward/SKILL.md','obsidian-lifeos-archive/SKILL.md']}})
    h=json.loads((OLD/'native-harness.json').read_text(encoding='utf-8'))
    assert digest(h['executable'])==h['binarySha256'] and h['collected']==1
    save('native-harness.json',h)
    print('Scope, lifecycle, costs and acceptance registered.')

def development():
    from grounding_index import Index,lexical_query,evidence_window
    from passage_index import tokenizer,terms
    from fastembed import TextEmbedding
    old=json.loads((OLD/'evaluation.json').read_text(encoding='utf-8'))
    corpus=json.loads((OLD/'corpus.json').read_text(encoding='utf-8'))
    cases=json.loads((OLD/'validation.json').read_text(encoding='utf-8'))['cases']
    queries=[q for q in cases if q['expected'] or q['id']=='q-4d8252c35a114c76']
    idx=Index.__new__(Index);idx.root=WORK/'development';idx.root.mkdir()
    manifest=json.loads((ROOT/'.local/hbm-00/parity-20261018b/formal-index/passages.json').read_text(encoding='utf-8'))
    idx.records={r['id']:r for r in corpus['records']};idx.passages=manifest['passages'];idx.files=manifest['files'];idx.tok=tokenizer()
    idx.reranker=None;idx.rerank_cache={};idx.client=None;idx.by_parent={}
    from collections import Counter
    import math
    for p in idx.passages.values():idx.by_parent.setdefault(p['memoryId'],[]).append(p['id'])
    idx.termsets={p['id']:set(terms(p['text'])) for p in idx.passages.values()}
    df=Counter(t for ts in idx.termsets.values() for t in ts)
    idx.idf={t:math.log(1+len(idx.passages)/(1+n)) for t,n in df.items()}
    idx.native=sqlite3.connect((ROOT/'.local/hbm-00/parity-20261018c/formal-index/native.sqlite3').resolve().as_uri()+'?mode=ro',uri=True)
    idx.native.enable_load_extension(True);sqlite_vec.load(idx.native);idx.native.enable_load_extension(False)
    idx.embedding=TextEmbedding(model_name='BAAI/bge-small-zh-v1.5',threads=2,cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True,enable_cpu_mem_arena=False)
    results=[];began=time.perf_counter()
    try:
        lexical=idx.native_lexical(queries,read('native-harness.json'),'development')
        for n,q in enumerate(queries,1):
            r=idx.retrieve(q,lexical[q['id']],'hub-native-hybrid')
            results.append({'id':q['id'],'query':q['query'],'expected':q['expected'],'retrieval':r})
            print(json.dumps({'development':n,'total':len(queries)}),flush=True)
    finally:idx.close()
    save('development-retrieval.json',{'at':now(),'rows':results,'wallMs':(time.perf_counter()-began)*1000,'modelCalls':0,'holdout':False,
        'lexicalNonempty':sum(bool(r['retrieval']['lexical']) for r in results),
        'candidateHit':sum(bool(set(r['expected']) & {m['id'] for m in r['retrieval']['candidates']}) for r in results if r['expected'])})

def dev_model():
    data=read('development-retrieval.json')
    wanted=['q-4d8252c35a114c76','q-48f0a0808d4b978c']
    rows=[r for r in data['rows'] if r['id'] in wanted]
    assert len(rows)==2
    native=transport();wire=None;result={'status':'starting','calls':[],'rows':[]};began=time.perf_counter()
    try:
        wire=native.Wire(WORK/'development-server',http=False)
        for n,row in enumerate(rows,1):
            memories=row['retrieval']['candidates'];task={'id':row['id'],'project':'notes','question':row['query'],'candidateIds':[m['id'] for m in memories]}
            prompt=POLICY+'\n待核验数据：\n'+json.dumps({'memories':memories,'tasks':[task]},ensure_ascii=False)
            start=time.time_ns();answer,receipt=wire.app_call(prompt,SCHEMA,WORK/f'development-call-{n}');end=time.time_ns()
            result['calls'].append({'id':f'dev-{n}','startUnixNs':start,'endUnixNs':end,'receipt':receipt})
            checked=validate_decisions(answer,[task],memories)[0]
            result['rows'].append({'id':row['id'],'checked':checked,'expected':row['expected']})
        result['status']='completed'
    finally:
        if wire:
            try:result['drain']=wire.drain(2*len(result['calls']))
            finally:wire.close()
            result['ledger']=native.ledger(wire.telemetry.rows,result['calls'])
        result['wallMs']=(time.perf_counter()-began)*1000;save('development-model.json',result)
    print(json.dumps({'status':result['status'],'rows':result['rows']},ensure_ascii=False))

def freeze():
    d=read('development-retrieval.json');m=read('development-model.json')
    assert d['lexicalNonempty']>1 and m['status']=='completed'
    assert all(not r['checked']['invalid'] and bool(r['checked']['ids'])==bool(r['expected']) for r in m['rows'])
    import importlib.metadata
    weights={}
    for folder in ['models--Qdrant--bge-small-zh-v1.5','models--onnx-community--bge-reranker-v2-m3-ONNX']:
        root=ROOT/'.local/hbm-00/cache/models'/folder
        for p in root.rglob('*'):
            if p.is_file() and (p.suffix=='.onnx' or p.name in ['tokenizer.json','config.json']):weights[str(p.relative_to(ROOT))]=digest(p)
    save('method-contract.json',{'frozenAt':now(),'scopeSha256':digest(REPORTS/'scope-contract.json'),'sources':sources(),
        'policy':POLICY,'schema':SCHEMA,'model':MODEL,'effort':EFFORT,
        'developmentSources':[digest(REPORTS/n) for n in ['development-retrieval.json','development-model.json']],
        'newSourcesOrQuestionsRead':False,'annotation':'Primary agent and judge same family; no independent human/vendor annotation',
        'budgetChange':'6000 BGE candidate JSON vs previous2000, full cost counted; no claim of latency/token saving',
        'pinnedCachedModelFiles':weights,'packages':{n:importlib.metadata.version(n) for n in ['basic-memory','fastembed','onnxruntime','jieba','sqlite-vec']},
        'focusedChecksSha256':digest(REPORTS/'focused-checks-v2.json'),
        'developmentNote':'Full old retrieval regression started before newline-preserving constructor repair; resolver/query functions unchanged, constructor separately checked with real CRLF fixture.'})
    print('Method/scorer frozen BEFORE new material selection and question authoring.')

def repair(index):
    import run as bm
    began=time.perf_counter();repairs=[]
    try:index.prepare_bm();return []
    except TimeoutError:
        repairs.append({'stage':'initial-readiness','status':'timeout','wallMs':(time.perf_counter()-began)*1000})
    for project in sorted({r['project'] for r in index.records.values()}):
        env=bm.environment(index.state,'hybrid');env.update({'TEMP':str(WORK/'tmp'),'TMP':str(WORK/'tmp')})
        began=time.perf_counter();members=[];p=None
        try:
            with (WORK/f'repair-{project}.log').open('xb') as log:
                p=subprocess.Popen([sys.executable,'-m','basic_memory.cli.main','reindex','--embeddings','--project',project],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                while p.poll() is None and time.perf_counter()-began<900:
                    parent=psutil.Process(p.pid)
                    members=[{'pid':x.pid,'createTime':x.create_time()} for x in [parent,*parent.children(recursive=True)]]
                    time.sleep(.5)
                if p.poll() is None:raise TimeoutError('Explicit vector repair exceeded900s')
                assert p.returncode==0
        finally:
            for identity in reversed(members):
                try:
                    child=psutil.Process(identity['pid'])
                    if child.create_time()==identity['createTime'] and child.is_running():child.terminate();child.wait(timeout=5)
                except psutil.NoSuchProcess:pass
            if p:p.wait(timeout=10)
            repairs.append({'stage':'explicit-repair','project':project,'wallMs':(time.perf_counter()-began)*1000,'exitCode':p.returncode if p else None,'members':members})
            # Runtime receipt replaces only this run's evolving preparation state.
            bm.save(WORK/'preparation-repairs.json',repairs)
    index.prepare_bm()
    return repairs

def evaluate():
    from grounding_index import Index
    assert read('method-contract.json')['sources']==sources()
    frozen=read('validation-contract.json')
    assert frozen['corpusSha256']==digest(REPORTS/'corpus.json') and frozen['validationSha256']==digest(REPORTS/'validation.json')
    save('execution-start.json',{'at':now(),'executionNumber':1,'sources':sources()})
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    result={'status':'starting','rows':[],'modelCalls':[],'model':MODEL,'effort':EFFORT,'startedAt':now(),'explicitRetries':0}
    started=time.perf_counter();idx=wire=None;native=transport();model_began=None
    try:
        idx=Index(read('corpus.json'),'formal-index')
        print(json.dumps({'stage':'passages-written','passages':len(idx.passages),'records':len(idx.files)}),flush=True)
        result['preparationRepairs']=repair(idx)
        print(json.dumps({'stage':'bm-ready','ms':idx.bm_prepare_ms}),flush=True)
        idx.prepare_native_vectors()
        print(json.dumps({'stage':'native-vector-ready','ms':idx.native_prepare_ms,'audit':idx.embedding_audit}),flush=True)
        questions=read('validation.json')['cases']
        lexical=idx.native_lexical(questions,read('native-harness.json'),'formal')
        result['indexes']={'records':len(idx.files),'passages':len(idx.passages),'bmPrepareMs':idx.bm_prepare_ms,'bmInitializeMs':idx.bm_initialize_ms,
            'nativeVectorMs':idx.native_prepare_ms,'lexicalMs':idx.lexical_receipt['wallMs'],'embeddingParity':idx.embedding_audit,'bmResources':idx.bm_resources}
        model_began=time.perf_counter();wire=native.Wire(WORK/'formal-server',http=False)
        for number,q in enumerate(questions,1):
            order=['hub-native-hybrid','basic-memory-hybrid']
            if number%2==0:order.reverse()
            seen={}
            for backend in order:
                began=time.perf_counter();found=idx.retrieve(q,lexical[q['id']],backend)
                task={'id':q['id'],'project':q['project'],'question':q['query'],'candidateIds':[m['id'] for m in found['candidates']]}
                prompt=POLICY+'\n待核验数据：\n'+json.dumps({'memories':found['candidates'],'tasks':[task]},ensure_ascii=False)
                key=hashlib.sha256(prompt.encode()).hexdigest();shared=key in seen
                if not shared:
                    call_id=f'formal-{number:03}-{len(seen)+1}'
                    start=time.time_ns();answer,receipt=wire.app_call(prompt,SCHEMA,WORK/call_id);end=time.time_ns()
                    seen[key]={'answer':answer,'receipt':receipt,'callId':call_id}
                    result['modelCalls'].append({'id':call_id,'questionId':q['id'],'backend':backend,'startUnixNs':start,'endUnixNs':end,'receipt':receipt})
                call=seen[key];checked=validate_decisions(call['answer'],[task],found['candidates'])[0]
                row={'id':q['id'],'backend':backend,'retrieval':found,'checked':checked,'promptSha256':key,
                     'callId':call['callId'],'sharedIdenticalJudgement':shared,'observedHostMs':(time.perf_counter()-began)*1000,'modelMs':call['receipt']['durationMs']}
                save(f'row-{number:03}-{backend}.json',row);result['rows'].append(row)
            print(json.dumps({'completedQuestions':number,'total':len(questions),'modelCalls':len(result['modelCalls'])}),flush=True)
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__});raise
    finally:
        if wire:
            try:result['drain']=wire.drain(2*len(result['modelCalls']))
            except BaseException as e:result.update({'status':'failed','drainErrorType':type(e).__name__})
            finally:wire.close()
            result['modelBatchWallMs']=(time.perf_counter()-model_began)*1000
            try:result['ledger']=native.ledger(wire.telemetry.rows,result['modelCalls'])
            except BaseException as e:result.update({'status':'failed','ledgerErrorType':type(e).__name__})
        if idx:
            idx.close();result['bmResidual']=idx.client.residual if idx.client else []
        result['totalMs']=(time.perf_counter()-started)*1000;result['finishedAt']=now();save('evaluation.json',result)
    print(json.dumps({'status':result['status'],'rows':len(result['rows']),'calls':len(result['modelCalls'])}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['register','development','dev-model','freeze','evaluate'])
    {'register':register,'development':development,'dev-model':dev_model,'freeze':freeze,'evaluate':evaluate}[p.parse_args().phase]()
