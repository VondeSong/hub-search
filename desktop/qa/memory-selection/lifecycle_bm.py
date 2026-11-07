"""Basic Memory operational adapter: supported configuration, no vendor patch."""
import os, time, sqlite3, shutil, json
from types import SimpleNamespace
from lifecycle_support import *
import run as transport
from qualification_bm_lifecycle import body, inspect

_environment=transport.environment
def environment(state, mode):
    env=_environment(state,mode)
    cache=OLD/'bm-lifecycle/models'
    env.update(BASIC_MEMORY_SEMANTIC_EMBEDDING_CACHE_DIR=str(cache),FASTEMBED_CACHE_PATH=str(cache),
        HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HOME=str(WORK/'hf'),
        PATH=str(OLD/'bm-lifecycle/python')+os.pathsep+os.path.join(os.environ['SYSTEMROOT'],'System32'),
        TEMP=str(WORK/'tmp'),TMP=str(WORK/'tmp'))
    return env
transport.environment=environment

def corpus():return read(OLD_REPORTS/'backend-operational-corpus.json')['records']
def chunks(mid,content):
    from basic_memory.repository.semantic_chunking import compose_row_source_text,split_text_into_chunks
    return split_text_into_chunks(compose_row_source_text(SimpleNamespace(type='entity',title=mid,permalink=mid,content_snippet=content)))
def config(state,batch):
    cfg=read(OLD/'bm-lifecycle/state/config/config.json')
    cfg.update(projects={p:{'path':str(state/'notes'/p),'mode':'local'} for p in ['left','right']},
        semantic_embedding_batch_size=2,semantic_embedding_sync_batch_size=batch,
        semantic_embedding_threads=2,semantic_embedding_cache_dir=str(OLD/'bm-lifecycle/models'))
    transport.save(state/'config/config.json',cfg)
def rebind(state):
    """Supported CLI updates DB+config only; never moves source files."""
    if not (state/'config/memory.db').exists():return
    commands=[]
    for project in ['left','right']:
        command=[str(PYTHON),'-X','utf8','-m','basic_memory.cli.main','project','move',project,str(state/'notes'/project)]
        begin=time.perf_counter()
        with (state/f'rebind-{project}.log').open('xb') as log:
            p=subprocess.run(command,cwd=ROOT,env=environment(state,'hybrid'),stdout=log,stderr=subprocess.STDOUT,timeout=90,creationflags=FLAGS)
        commands.append({'project':project,'exitCode':p.returncode,'wallMs':(time.perf_counter()-begin)*1000})
        assert p.returncode==0,'Supported project move failed; do not launch service'
    with sqlite3.connect((state/'config/memory.db').resolve().as_uri()+'?mode=ro',uri=True) as c:
        paths=dict(c.execute('SELECT name,path FROM project'))
    assert all(Path(paths[p]).resolve()==(state/'notes'/p).resolve() for p in ['left','right'])
    save(state/'rebind.json',{'at':now(),'commands':commands,'pathsVerifiedBeforeService':True})
def prepare(state,batch,seed=False):
    if seed:
        shutil.copytree(OLD/'bm-lifecycle/state',state)
    else:state.mkdir(parents=True,exist_ok=False)
    config(state,batch)
    for r in corpus():
        p=state/'notes'/r['project']/(r['id']+'.md');p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(f'---\ntitle: {r["id"]}\ntype: note\npermalink: {r["id"]}\n---\n\n'+r['content'],encoding='utf-8')
    rebind(state)

class BM:
    def __init__(self,state):
        assert Path(os.sys.executable).resolve()==PYTHON.resolve(),'Use the relocated managed Python'
        if (state/'config/memory.db').exists():
            with sqlite3.connect((state/'config/memory.db').resolve().as_uri()+'?mode=ro',uri=True) as c:
                paths=dict(c.execute('SELECT name,path FROM project'))
            assert all(Path(paths[p]).resolve()==(state/'notes'/p).resolve() for p in ['left','right']),'Reject stale project roots before starting MCP'
        self.state=state;self.client=transport.Mcp(state,'hybrid');self.last_ack=None
        required={'write_note','delete_note','read_note','search_notes'}
        assert required<={t['name'] for t in self.client.catalog}
    def write(self,mid,content,project='left'):
        start=time.perf_counter()
        assert mid.startswith('hbm-op-') and all(c.isalnum() or c=='-' for c in mid)
        explicit_content=f'---\npermalink: {mid}\n---\n\n'+content
        r=self.client.call('write_note',{'title':mid,'content':explicit_content,'directory':'','project':project,'overwrite':True,'output_format':'json'})
        self.last_ack=time.perf_counter()
        return {'ackMs':(self.last_ack-start)*1000,'responseSha256':hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest()}
    def delete(self,mid,project='left'):
        start=time.perf_counter()
        r=self.client.call('delete_note',{'identifier':mid,'project':project,'is_directory':False,'output_format':'json'})
        self.last_ack=time.perf_counter()
        return {'ackMs':(self.last_ack-start)*1000,'responseSha256':hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest()}
    def snapshot(self):
        d=inspect(self.state)
        from basic_memory.file_utils import remove_frontmatter
        files={}
        for project in ['left','right']:
            for p in (self.state/'notes'/project).glob('*.md'):
                assert p.stem not in files,'Duplicate stable identity across fixture projects'
                files[p.stem]=remove_frontmatter(p.read_text(encoding='utf-8')).replace('\r\n','\n').strip()
        return {'notes':{mid:content for mid,content in d['search']},
          'chunks':{mid:[c[1] for c in d['chunks'] if c[0]==mid] for _,mid,_,_ in d['entities']},
          'ready':all(c[2]=='ready' for c in d['chunks']),
          'orphans':d['orphanVectors']+d['orphanChunks']+d['orphanSearch'],
          'entityCount':len(d['entities']),'vectors':d['vectors'],
          'projectPaths':dict(d['projects']),'files':files}
    def search(self,query,project='left',lexical=None):
        base={'project':project,'search_all_projects':False,'entity_types':['entity'],'page_size':50,'output_format':'json'}
        v=self.client.call('search_notes',{**base,'query':query,'search_type':'vector','min_similarity':0.0})
        t=self.client.call('search_notes',{**base,'query':lexical or query,'search_type':'text'})
        return {'vectorIds':[transport.hit_identity(x) for x in transport.results_from(v)],
                'lexicalIds':[transport.hit_identity(x) for x in transport.results_from(t)]}
    def readback(self,mid,content,project='left'):
        r=self.client.call('read_note',{'identifier':mid,'project':project})
        def strings(v):
            if isinstance(v,str):yield v
            elif isinstance(v,dict):
                for x in v.values():yield from strings(x)
            elif isinstance(v,list):
                for x in v:yield from strings(x)
        return any(content.replace('\r\n','\n').strip() in x.replace('\r\n','\n') for x in strings(r))
    def usage(self):return self.client.usage()
    def close(self):self.client.close();return self.client.residual

def matches(actual,expected):
    if not actual['ready'] or actual['orphans'] or set(actual['notes'])!=set(expected):return False
    if actual['entityCount']!=len(expected):return False
    if 'files' in actual and actual['files']!={mid:b.replace('\r\n','\n').strip() for mid,b in expected.items()}:return False
    for mid,content in expected.items():
        if actual['notes'][mid].replace('\r\n','\n').strip()!=content.replace('\r\n','\n').strip():return False
        if sorted(actual['chunks'].get(mid,[]))!=sorted(chunks(mid,content)):return False
    return actual['vectors']==sum(len(chunks(mid,b)) for mid,b in expected.items())

def observe(client,expected,since=None,timeout=60):
    start=time.perf_counter() if since is None else since
    attempts=0
    while time.perf_counter()-start<timeout:
        attempts+=1
        try:
            d=client.snapshot()
            if matches(d,expected):
                ms=(time.perf_counter()-start)*1000
                return {'ready':True,'elapsedMs':ms,'within5s':ms<=5000,'polls':attempts}
        except sqlite3.OperationalError:pass
        time.sleep(.1)
    return {'ready':False,'elapsedMs':(time.perf_counter()-start)*1000,'within5s':False,'polls':attempts}

def profile():
    assert not (REPORTS/'bm-profile-v2.json').exists()
    save(REPORTS/'bm-profile-v2-method.json',{'at':now(),'sourceSha256':digest(__file__),'scopeSha256':digest(REPORTS/'scope.json'),
       'arms':[2,32],'updatesPerArm':4,'ids':[0,1,2,3],'seed':'independent copies of previous closed100note/5100vector store; canonical V0 restored and waited ready before timing',
       'onlyVariable':'semantic_embedding_sync_batch_size','diagnosticWaitSeconds':60,'passPostAckMs':5000})
    results=[]
    try:
        for batch in [2,32]:
            state=WORK/f'bm-profile-v2-{batch}';prepare(state,batch,seed=True)
            expected={r['id']:r['content'] for r in corpus()};client=None
            arm={'batch':batch,'updates':[]};results.append(arm)
            try:
                client=BM(state);assert observe(client,expected,timeout=120)['ready']
                for n in range(4):
                    mid=f'hbm-op-{n:03}';content=body(n,1);start=time.perf_counter()
                    row={'id':mid,'at':now()};arm['updates'].append(row)
                    row.update(client.write(mid,content));expected[mid]=content
                    row['visibility']=observe(client,expected,client.last_ack)
                    row['fullMs']=(time.perf_counter()-start)*1000
                    assert row['visibility']['ready'],'Diagnostic convergence failed'
                arm['resources']=client.usage()
            finally:
                if client:arm['residual']=client.close()
    finally:save(REPORTS/'bm-profile-v2.json',{'at':now(),'arms':results,'modelCalls':0})
    print(json.dumps({'arms':[{ 'batch':a['batch'],'postAckMs':[round(r['visibility']['elapsedMs'],2) for r in a['updates']]} for a in results]}))

if __name__=='__main__':profile()
