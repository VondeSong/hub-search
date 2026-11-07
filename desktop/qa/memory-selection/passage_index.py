"""Experiment: canonical files -> token-bounded passages -> real BM MCP + local FTS.

The host owns passage-to-memory identity; this is not a production backend choice.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time

os.environ['TOKENIZERS_PARALLELISM'] = 'false'

import jieba
import run as bm
import sqlite_vec
from tokenizers import Tokenizer

from passage_support import ROOT, WORK, digest

STOP = {'什么','怎么','多少','这次','那个','这个','这里','现在','是不是','是否','已经','到底','时候','应该','可以','我们','一下','需要','还有','进行','什么样','相关','目前','本轮','本次','哪些','如何','怎样','能否','一个','一份','一条','一样','还是','或者','但是','因为','所以','以及','不能','没有','之前','之后','刚刚','的是','的','了','和','在','是','我','你','把','那','这','用','都','就','要','还','也','不','吗','呢'}


def tokenizer():
    # Read cached tokenizer, no model downloads or heavyweight model instance needed.
    root = ROOT / '.local/hbm-00/cache/models/models--Qdrant--bge-small-zh-v1.5'
    paths = sorted(root.rglob('tokenizer.json'))
    if len(paths)!=1:
        raise ValueError('Expected one pinned cached BGE tokenizer')
    tok = Tokenizer.from_file(str(paths[0]))
    tok.no_truncation()
    tok.no_padding()
    return tok


def split_body(text, tok, limit=256, overlap=32):
    """Exact source offsets; paragraph boundaries before generic token windows."""
    pieces = []
    for match in re.finditer(r'\S[\s\S]*?(?=\n\s*\n|\Z)', text):
        begin, end = match.span()
        while end>begin and text[end-1].isspace():
            end-=1
        encoded = tok.encode(text[begin:end], add_special_tokens=False)
        if not encoded.ids:
            continue
        start_token = 0
        while start_token<len(encoded.ids):
            stop_token = min(start_token+limit,len(encoded.ids))
            left = begin+encoded.offsets[start_token][0]
            right = begin+encoded.offsets[stop_token-1][1]
            if right>left:
                pieces.append({'start':left,'end':right,'text':text[left:right]})
            if stop_token==len(encoded.ids):
                break
            start_token=stop_token-overlap
    if not pieces:
        raise ValueError('Empty memory cannot enter passage index')
    return pieces


def terms(text):
    text = text.lower()
    words = list(jieba.cut_for_search(text, HMM=False))
    # Preserve ASCII identifiers, Chinese search terms and meaningful numbers.
    return sorted({w.strip() for w in words if w.strip() not in STOP and
                   (len(w.strip())>=2 or w.strip().isdigit()) and re.search(r'[\w\u4e00-\u9fff]',w)})


class Index:
    def __init__(self, corpus, name):
        self.corpus=corpus
        self.root=WORK/name
        self.root.mkdir(parents=True,exist_ok=False)
        self.client=None
        self.tok=tokenizer()
        self.records={r['id']:r for r in corpus['records']}
        self.passages={}
        self.files={}
        self.reranker=None
        jieba.dt.tmp_dir=str(self.root)
        jieba.initialize()
        self.lex=sqlite3.connect(self.root/'lexical.sqlite3')
        self.lex.execute('CREATE VIRTUAL TABLE passages USING fts5(pid UNINDEXED,mid UNINDEXED,project UNINDEXED,tokens)')
        for record in corpus['records']:
            path=self.root/'canonical'/record['project']/(record['id']+'.md')
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(record['content'],encoding='utf-8')
            self.files[record['id']]={'path':str(path),'sha256':digest(path)}
            for number,piece in enumerate(split_body(record['content'],self.tok)):
                pid='p-'+hashlib.sha256(f'{record["id"]}/{number}/{piece["start"]}/{piece["end"]}'.encode()).hexdigest()[:16]
                prefix=record['title']
                prefix_encoding=self.tok.encode(prefix,add_special_tokens=False)
                if len(prefix_encoding.ids)>48:
                    prefix=prefix[:prefix_encoding.offsets[47][1]]
                embedded=prefix+'\n'+piece['text']
                if len(self.tok.encode(embedded).ids)>320:
                    raise ValueError('Passage embedding input would exceed reserved token budget')
                p={**piece,'id':pid,'memoryId':record['id'],'project':record['project'],
                   'embeddingTokens':len(self.tok.encode(embedded).ids)}
                self.passages[pid]=p
                note=self.root/'bm/notes'/record['project']/(pid+'.md')
                note.parent.mkdir(parents=True,exist_ok=True)
                note.write_text(f'---\ntitle: {prefix}\ntype: note\npermalink: {pid}\n---\n\n{piece["text"]}\n',encoding='utf-8')
                self.lex.execute('INSERT INTO passages VALUES (?,?,?,?)',(pid,record['id'],record['project'],' '.join(terms(prefix+' '+piece['text']))))
        self.lex.commit()
        self.state=self.root/'bm'
        config=json.loads((ROOT/'.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
        config['projects']={project:{'path':str(self.state/'notes'/project),'mode':'local'} for project in sorted({r['project'] for r in corpus['records']})}
        bm.save(self.state/'config/config.json',config)
        bm.save(self.root/'passage-manifest.json',{'records':self.files,'passages':self.passages,
                                                  'bodyTokenLimit':256,'tokenOverlap':32,
                                                  'tokenizer':'Pinned cached BGE Chinese small, no truncation during splitting'})
        start=time.perf_counter()
        self.client=bm.Mcp(self.state,'hybrid')
        self.initialize_ms=self.client.initialize_ms
        # Read actual persisted readiness, not self-search rank (duplicate passages can tie).
        deadline=time.monotonic()+300
        while True:
            path=self.state/'config/memory.db'
            ready=set()
            try:
                con=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
                con.enable_load_extension(True)
                sqlite_vec.load(con)
                ready={row[0] for row in con.execute("SELECT e.permalink FROM entity e JOIN search_vector_chunks c ON c.entity_id=e.id WHERE c.embedding_status='ready' GROUP BY e.id")}
                con.close()
            except sqlite3.OperationalError:
                pass
            missing=set(self.passages)-ready
            bm.save(self.root/'readiness.json',{'expected':len(self.passages),'ready':len(set(self.passages)&ready),
                                              'missing':sorted(missing),'elapsedMs':(time.perf_counter()-start)*1000})
            if not missing:
                break
            if time.monotonic()>deadline:
                self.close()
                raise TimeoutError('Passage vector index readiness exceeded 300 seconds')
            time.sleep(2)
        self.prepare_ms=(time.perf_counter()-start)*1000

    def search(self, query, project, rerank=True):
        began=time.perf_counter()
        hits=bm.results_from(self.client.call('search_notes',{'query':query,'project':project,
            'search_all_projects':False,'search_type':'vector','min_similarity':0.0,
            'page_size':80,'entity_types':['entity'],'output_format':'json'}))
        vector=[]
        by_memory={}
        excluded=[]
        for hit in hits:
            pid=bm.hit_identity(hit)
            passage=self.passages.get(pid)
            if not passage:
                excluded.append({'id':pid,'reason':'unknown_passage'})
                continue
            record=self.records[passage['memoryId']]
            if record['project']!=project or record['status']!='confirmed':
                excluded.append({'id':pid,'reason':'scope_state'})
                continue
            mid=record['id']
            if mid not in by_memory:
                by_memory[mid]=[]
                vector.append(mid)
            if pid not in by_memory[mid]:
                by_memory[mid].append(pid)
        lexical=[]
        words=terms(query)
        if words:
            expression=' OR '.join('"'+word.replace('"','""')+'"' for word in words)
            rows=self.lex.execute('SELECT pid,mid FROM passages WHERE passages MATCH ? AND project=? ORDER BY bm25(passages),pid LIMIT 80',(expression,project)).fetchall()
            for pid,mid in rows:
                record=self.records[mid]
                if record['project']!=project or record['status']!='confirmed':
                    continue
                if mid not in lexical:
                    lexical.append(mid)
                if mid not in by_memory:
                    by_memory[mid]=[]
                if pid not in by_memory[mid]:
                    by_memory[mid].append(pid)
        scores={}
        for ranking in [vector,lexical]:
            for i,mid in enumerate(ranking):
                scores[mid]=scores.get(mid,0)+1/(60+i+1)
        fused=sorted(scores,key=lambda mid:(-scores[mid],mid))[:20]
        reranked=[]
        rerank_ms=0
        if rerank:
            if self.reranker is None:
                from fastembed.rerank.cross_encoder import TextCrossEncoder
                self.reranker=TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8',threads=2,
                                                cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True)
            start=time.perf_counter()
            docs=[]
            owners=[]
            for mid in fused:
                for pid in by_memory[mid][:2]:
                    docs.append(self.records[mid]['title']+'\n'+self.passages[pid]['text'])
                    owners.append(mid)
            model_scores=list(self.reranker.rerank(query,docs,batch_size=8)) if docs else []
            best={}
            for mid,score in zip(owners,model_scores):
                best[mid]=max(best.get(mid,float('-inf')),float(score))
            reranked=sorted(best,key=lambda mid:(-best[mid],mid))
            rerank_ms=(time.perf_counter()-start)*1000
        return {'vector':vector[:20],'lexical':lexical[:20],'fused':fused,'reranked':reranked,
                'passageIds':by_memory,'excluded':excluded,'rerankMs':rerank_ms,
                'retrievalMs':(time.perf_counter()-began)*1000,'rawPassageHits':len(hits)}

    def candidates(self, ids, project):
        result=[]
        for mid in ids[:5]:
            record=self.records[mid]
            if record['project']!=project or record['status']!='confirmed':
                raise ValueError('Final candidate scope or state violated')
            file=self.files[mid]
            if digest(file['path'])!=file['sha256']:
                raise ValueError('Canonical body changed')
            result.append({'id':mid,'project':project,'status':'confirmed','title':record['title'],'text':record['content']})
        return result

    def close(self):
        if self.client:
            self.client.close()
            self.residual=self.client.residual
        self.lex.close()
