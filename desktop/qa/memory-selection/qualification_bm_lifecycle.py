"""Isolated Basic Memory whole-note operational gate, not quality tuning.

The 100-note/5000-bullet workload is SYNTHETIC lifecycle material. It cannot
establish semantic quality, production Hub integration or Rust storage parity.
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from qualification_contract import ROOT, WORK, REPORTS, read, save, digest, now
from qualification_rust_runtime import ensure_quality_closed, stop_owned, FLAGS

AREA=WORK/'bm-lifecycle'
TOPICS=['资料整理','版本审核','文件备份','来源核对','项目隔离','设备维护','学习记录','任务交接','日程安排','材料清单']


def contract_name():
    return 'bm-lifecycle-contract-v2.json' if (REPORTS/'bm-lifecycle-contract-v2.json').exists() else 'bm-lifecycle-contract.json'


def body(number,revision=0):
    sections=[]
    for i in range(50):
        marker=f'HBMOP{number:03}S{i:02}V{revision}'
        sections.append(f'- {TOPICS[number%len(TOPICS)]}的第{i+1}项记录，核对口令是{marker}。'
            '办理时先检查文件的来源和生效日期，再核对所属项目；完成后保存本次确认的结果。'
            '旧记录失效后应从检索结果中移除，不能用相同标题代替稳定身份。'
            '本段是隔离测试使用的虚构材料，不是用户的实际决定。')
    return '\n\n'.join(sections)+'\n'


def register():
    assert not (REPORTS/'bm-lifecycle-contract.json').exists()
    corpus=[{'id':f'hbm-op-{i:03}','project':'left' if i<80 else 'right','title':f'hbm-op-{i:03}',
             'content':body(i)} for i in range(100)]
    assert all(len(r['content'].encode())<=60000 for r in corpus)
    save('backend-operational-corpus.json',{'records':corpus,'synthetic':True,'semanticQualityEvidence':False,
         'purpose':'100 whole notes,50 independent prose bullets each; exact state/forgetting and deployment tests'})
    save('bm-lifecycle-contract.json',{'at':now(),'sources':{Path(__file__).name:digest(__file__)},
        'scopeContractSha256':digest(REPORTS/'scope-contract.json'),
        'corpusSha256':digest(REPORTS/'backend-operational-corpus.json'),
        'method':{'runtime':'Copy existing exact CPython base, create owned venv without pip, copy frozen installed packages and model; start service using relocated Python with isolated config and cache.',
            'index':'100 whole files; expected5000entity chunks from50prose bullets per file, record actual count and fail target gate if different.',
            'installIndexDeadlineSeconds':1200,'coldRuns':5,'firstUsableMaxMs':10000,
            'startupQuery':'First vector query after fresh MCP launch; installed existing index, first embedding included, no OS cache flush.',
            'update':'IDs0..19 overwrite whole body revision1; retry identical overwrite; file readback, text index and vector chunks checked. Retrieval invisibility also checked after delete.',
            'delete':'IDs20..39 delete via MCP; repeat delete; note file/entity/search/vector rows must disappear.',
            'replace':'IDs40..59 create successor100..119 then delete predecessor; both operations timed; cannot claim atomic pair.',
            'visibility':'After each acknowledged write/delete poll<=5s for authoritative file and indexed state; timeout is failed gate, no threshold relaxation.',
            'restart':'Close producer then fresh process, inspect acknowledged body hashes, deletions, duplicates and pending vectors.',
            'backup':'After close copy entire owned data/config/notes; restore to new root and rewrite only configured project paths; compare state and deletion set.',
            'crash':'Not exercised by this script; remains mandatory and unverified.',
            'derivedSummaries':'Basic Memory entity/search/vector orphan counts audited; derived Hub summaries and content-history erasure are not implemented, whole forgetting gate stays partial.',
            'soak':'Not started by this script; real24h gate remains unverified.',
            'timing':'Sequential after common quality and Rust runtime gate; no competing benchmark; raw latency, retry and failed operations retained.'},
        'backendSelection':False,'productionOrVaultWrites':False})
    print('Basic Memory lifecycle/deployment method frozen before execution.')


def install():
    ensure_quality_closed()
    assert digest(__file__)==read(contract_name())['sources'][Path(__file__).name]
    assert shutil.disk_usage(WORK).free>=10*1024**3
    AREA.mkdir(exist_ok=False)
    inventory=read('backend-dependency-inventory.json');began=time.perf_counter()
    result={'at':now(),'status':'running','sourceInventorySha256':digest(REPORTS/'backend-dependency-inventory.json')}
    try:
        shutil.copytree(inventory['pythonBase']['path'],AREA/'python')
        with (AREA/'venv.log').open('xb') as log:
            p=subprocess.Popen([str(AREA/'python/python.exe'),'-m','venv','--copies','--without-pip',str(AREA/'runtime')],
                cwd=AREA,stdout=log,stderr=subprocess.STDOUT,creationflags=FLAGS)
            try:code=p.wait(timeout=120)
            finally:stop_owned(p)
        assert code==0
        shutil.copytree(ROOT/'.local/hbm-00/runtime/Lib/site-packages',AREA/'runtime/Lib/site-packages',dirs_exist_ok=True)
        # Preserve the cache layout expected by FastEmbed, including exact snapshot identity.
        source_model=ROOT/'.local/hbm-00/cache/models/models--Qdrant--bge-small-zh-v1.5'
        shutil.copytree(source_model,AREA/'models'/source_model.name)
        result.update(status='completed',python=str(AREA/'runtime/Scripts/python.exe'),
            base=str(AREA/'python'),logicalBytes=sum(p.stat().st_size for p in AREA.rglob('*') if p.is_file()),
            packageVersion='0.23.2',functionalReady=False)
    except BaseException as error:
        result.update(status='failed',errorType=type(error).__name__,error=str(error)[:400]);raise
    finally:
        result['wallMs']=(time.perf_counter()-began)*1000
        save('bm-managed-runtime-install.json',result)


def settings(state):
    config=json.loads((ROOT/'.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
    config.update(projects={name:{'path':str(state/'notes'/name),'mode':'local'} for name in ['left','right']},
        default_project=None,auto_update=False,cloud_promo_opt_out=True,logfire_enabled=False,
        logfire_send_to_logfire=False,semantic_search_enabled=True,reranker_enabled=False,
        semantic_vector_k=500,semantic_embedding_cache_dir=str(AREA/'models'))
    return config


def configure():
    import run as bm
    original=bm.environment
    def environment(state,mode):
        env=original(state,mode)
        env.update(BASIC_MEMORY_SEMANTIC_EMBEDDING_CACHE_DIR=str(AREA/'models'),FASTEMBED_CACHE_PATH=str(AREA/'models'),
            HF_HOME=str(AREA/'huggingface'),HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',
            PATH=str(AREA/'python')+os.pathsep+os.path.join(os.environ['SystemRoot'],'System32'),
            TEMP=str(AREA/'tmp'),TMP=str(AREA/'tmp'))
        return env
    bm.environment=environment
    return bm


def inspect(state):
    import sqlite_vec
    con=sqlite3.connect((state/'config/memory.db').resolve().as_uri()+'?mode=ro',uri=True)
    try:
        con.enable_load_extension(True);sqlite_vec.load(con);con.enable_load_extension(False)
        return {'projects':con.execute('SELECT name,path FROM project').fetchall(),
            'entities':con.execute('SELECT id,permalink,file_path,checksum FROM entity ORDER BY id').fetchall(),
            'chunks':con.execute('SELECT e.permalink,c.chunk_text,c.embedding_status FROM search_vector_chunks c JOIN entity e ON e.id=c.entity_id ORDER BY c.id').fetchall(),
            'search':con.execute('SELECT e.permalink,s.content_snippet FROM search_index s JOIN entity e ON s.entity_id=e.id ORDER BY e.id').fetchall(),
            'vectors':con.execute('SELECT count(*) FROM search_vector_embeddings').fetchone()[0],
            'orphanVectors':con.execute('SELECT count(*) FROM search_vector_embeddings v LEFT JOIN search_vector_chunks c ON c.id=v.rowid WHERE c.id IS NULL').fetchone()[0],
            'orphanChunks':con.execute('SELECT count(*) FROM search_vector_chunks c LEFT JOIN entity e ON e.id=c.entity_id WHERE e.id IS NULL').fetchone()[0],
            'orphanSearch':con.execute('SELECT count(*) FROM search_index s LEFT JOIN entity e ON e.id=s.entity_id WHERE e.id IS NULL').fetchone()[0]}
    finally:con.close()


def wait_state(state, predicate, seconds):
    begin=time.perf_counter();last=None
    while time.perf_counter()-begin<=seconds:
        try:
            last=inspect(state)
            if predicate(last):return last,(time.perf_counter()-begin)*1000
        except sqlite3.OperationalError:pass
        time.sleep(.15)
    raise TimeoutError(f'Index visibility exceeded {seconds}s; observed counts '+str(None if last is None else (len(last['entities']),len(last['chunks']))))


def launch_managed():
    ensure_quality_closed()
    assert read('bm-managed-runtime-install.json')['status']=='completed'
    cmd=[str(AREA/'runtime/Scripts/python.exe'),'-X','utf8',str(Path(__file__).resolve()),'exercise']
    with (AREA/'managed-exercise.log').open('xb') as log:
        p=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=FLAGS)
        try:code=p.wait(timeout=1800)
        finally:stop_owned(p)
    assert code==0, 'Managed exercise failed; raw report and log retained'


def exercise():
    ensure_quality_closed()
    assert Path(sys.prefix).resolve()==(AREA/'runtime').resolve()
    assert Path(sys.base_prefix).resolve()==(AREA/'python').resolve()
    import basic_memory
    import onnxruntime
    for module in [basic_memory,onnxruntime]:
        assert Path(module.__file__).resolve().is_relative_to((AREA/'runtime').resolve()), 'Imported an external installation'
    contract=read(contract_name())
    assert digest(__file__)==contract['sources'][Path(__file__).name]
    assert digest(REPORTS/'backend-operational-corpus.json')==contract['corpusSha256']
    bm=configure();state=AREA/'state';(AREA/'tmp').mkdir(exist_ok=True)
    state.mkdir(exist_ok=False)
    for name in ['left','right']:(state/'notes'/name).mkdir(parents=True)
    bm.save(state/'config/config.json',settings(state))
    corpus=read('backend-operational-corpus.json')['records']
    for record in corpus:
        note=state/'notes'/record['project']/(record['id']+'.md')
        note.write_text(f'---\ntitle: {record["title"]}\ntype: note\npermalink: {record["id"]}\n---\n\n'+record['content'],encoding='utf-8')
    result={'at':now(),'status':'running','operations':[],'coldRuns':[], 'modelCalls':0,
        'actualPython':sys.executable,'actualBase':sys.base_prefix,'syntheticOperationalWorkload':True,
        'fullHubIntegration':False,'crashVerified':False,'derivedHubSummariesVerified':False,'real24hVerified':False}
    client=None;start=time.perf_counter()
    try:
        client=bm.Mcp(state,'hybrid')
        first,index_ms=wait_state(state,lambda d:len(d['entities'])==100 and len(d['chunks'])>=5000 and all(c[2]=='ready' for c in d['chunks']),1200)
        result['initialIndex']={'wallMs':(time.perf_counter()-start)*1000,'chunks':len(first['chunks']),
            'entities':len(first['entities']),'vectors':first['vectors'],'targetPassed':len(first['chunks'])==5100,
            'expectedBodyChunks':5000,'expectedTitlePermalinkChunks':100}
        client.close();client=None
        for run in range(1,6):
            t=time.perf_counter();client=bm.Mcp(state,'hybrid')
            hits=bm.results_from(client.call('search_notes',{'query':corpus[0]['content'][:230], 'project':'left',
                'search_all_projects':False,'search_type':'vector','min_similarity':0.0,'entity_types':['entity'],'page_size':50,'output_format':'json'}))
            elapsed=(time.perf_counter()-t)*1000
            assert 'hbm-op-000' in [bm.hit_identity(h) for h in hits]
            result['coldRuns'].append({'number':run,'firstUsableMs':elapsed,'within10s':elapsed<=10000,'resources':client.usage()})
            if run<5:client.close();client=None
        expected={r['id']:r['content'] for r in corpus};deleted=[]
        for kind,numbers in [('update',range(20)),('delete',range(20,40)),('replace',range(40,60))]:
            for number in numbers:
                mid=f'hbm-op-{number:03}';t=time.perf_counter()
                entry={'kind':kind,'id':mid,'status':'running'};result['operations'].append(entry)
                if kind=='update':
                    content=body(number,1)
                    args={'title':mid,'content':content,'directory':'','project':'left','overwrite':True,'output_format':'json'}
                    client.call('write_note',args);ack=time.perf_counter()
                    expected[mid]=content
                    predicate=lambda d,m=mid,n=number: (len([e for e in d['entities'] if e[1]==m])==1 and
                        any(c[0]==m and f'HBMOP{n:03}S00V1' in c[1] for c in d['chunks']) and
                        not any(c[0]==m and 'V0' in c[1] for c in d['chunks']) and
                        not any(s[0]==m and 'V0' in s[1] for s in d['search']) and
                        all(c[2]=='ready' for c in d['chunks']))
                    _,visibility=wait_state(state,predicate,5)
                    assert content.strip() in (state/'notes/left'/(mid+'.md')).read_text(encoding='utf-8')
                    client.call('write_note',args)
                    wait_state(state,predicate,5)
                else:
                    if kind=='replace':
                        successor=f'hbm-op-{number+60:03}';content=body(number+60)
                        client.call('write_note',{'title':successor,'content':content,'directory':'','project':'left','overwrite':False,'output_format':'json'})
                        expected[successor]=content
                    client.call('delete_note',{'identifier':mid,'project':'left','is_directory':False,'output_format':'json'});ack=time.perf_counter()
                    del expected[mid];deleted.append(mid)
                    predicate=lambda d,m=mid: (not any(e[1]==m for e in d['entities']) and
                        not any(c[0]==m for c in d['chunks']) and not any(s[0]==m for s in d['search']) and
                        not d['orphanVectors'] and not d['orphanChunks'] and not d['orphanSearch'])
                    _,visibility=wait_state(state,predicate,5)
                    client.call('delete_note',{'identifier':mid,'project':'left','is_directory':False,'output_format':'json'})
                    assert not (state/'notes/left'/(mid+'.md')).exists()
                    hits=bm.results_from(client.call('search_notes',{'query':body(number)[:230],'project':'left',
                        'search_all_projects':False,'search_type':'vector','min_similarity':0.0,'entity_types':['entity'],
                        'page_size':50,'output_format':'json'}))
                    assert not set(deleted)&{bm.hit_identity(h) for h in hits}
                entry.update(status='completed',ackMs=(ack-t)*1000,postAckVisibilityMs=visibility,
                    fullIncludingRetryMs=(time.perf_counter()-t)*1000)
                bm.save(AREA/'progress.json',result)
        client.close();client=None
        shutil.copytree(state,AREA/'backup')
        restored=AREA/'restored';shutil.copytree(AREA/'backup',restored)
        bm.save(restored/'config/config.json',settings(restored))
        client=bm.Mcp(restored,'hybrid')
        recovered,_=wait_state(restored,lambda d:len(d['entities'])==len(expected) and all(c[2]=='ready' for c in d['chunks']),60)
        assert all(Path(path).resolve()==(restored/'notes'/name).resolve() for name,path in recovered['projects'] if name in ['left','right']), 'Restored service still refers to original source paths'
        assert {e[1] for e in recovered['entities']}==set(expected)
        for mid,content in expected.items():
            paths=list((restored/'notes').glob('*/'+mid+'.md'))
            assert len(paths)==1 and content.strip() in paths[0].read_text(encoding='utf-8')
        assert not any(c[0] in deleted for c in recovered['chunks'])
        result.update(status='completed',restoredExpectedHashes={k:hashlib.sha256(v.encode()).hexdigest() for k,v in expected.items()},
            deletedIds=deleted,backupRestorePassed=True, finalResources=client.usage())
    except BaseException as error:
        result.update(status='failed',errorType=type(error).__name__,error=str(error)[:500]);raise
    finally:
        if client:
            client.close();result['residual']=client.residual
        result['wallMs']=(time.perf_counter()-start)*1000
        save('bm-lifecycle-result.json',result)


def amend_preflight():
    from types import SimpleNamespace
    from basic_memory.repository.semantic_chunking import compose_row_source_text,split_text_into_chunks
    from basic_memory.markdown.entity_parser import parse
    original=read('bm-lifecycle-contract.json')
    assert not AREA.exists(), 'No operational execution may precede this preflight correction'
    assert digest(REPORTS/'bm-lifecycle-v1-source.py')==original['sources'][Path(__file__).name]
    corpus=read('backend-operational-corpus.json')['records'];counts=[]
    for r in corpus:
        parsed=parse(r['content']);assert not parsed.observations and not parsed.relations
        row=SimpleNamespace(type='entity',title=r['title'],permalink=r['id'],content_snippet=parsed.content)
        counts.append(len(split_text_into_chunks(compose_row_source_text(row))))
    assert counts==[51]*100
    updated={**original,'at':now(),'sources':{Path(__file__).name:digest(__file__)},
        'supersedesSha256':digest(REPORTS/'bm-lifecycle-contract.json'),
        'preExecutionCorrection':'Pure upstream parser preflight: each whole note adds a title/permalink chunk before its50bullet chunks. Body-only preflight missed100metadata chunks. No service, model, timing or lifecycle outcomes observed; corpus and user scale target unchanged.',
        'expectedEntityChunks':5100,'expectedBodyChunks':5000,'expectedMetadataChunks':100,
        'method':{**original['method'],'index':'100 whole files,5000body chunks+100upstream title/permalink chunks=5100total. Actual count remains audited; this exceeds the5000scale target without claiming exactly5000physical vectors.'}}
    save('bm-lifecycle-contract-v2.json',updated)
    print(json.dumps({'wholeNotes':100,'bodyChunks':5000,'metadataChunks':100,'physicalEntityChunks':sum(counts),'serviceStarted':False}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['register','amend-preflight','install','launch','exercise'])
    {'register':register,'amend-preflight':amend_preflight,'install':install,'launch':launch_managed,'exercise':exercise}[p.parse_args().phase]()
