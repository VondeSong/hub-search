"""Shared representation and host policy; two real, independently indexed vector stores.

The controlled representation is exported from BM's parser before any queries.
No BM stored vectors are copied. This isolates service/storage, not parsers.
The native vector host is a Python fixture, NOT completed Rust integration.
"""
import hashlib
import json
import math
import os
import sqlite3
import subprocess
import time
from pathlib import Path

from parity_support import ROOT, WORK, REPORTS, digest, runtime_save
from passage_index import tokenizer, split_body, terms
import run as bm
import sqlite_vec

def unique(items):
    return list(dict.fromkeys(items))

def fuse(a, b):
    scores = {}
    for ranking in [unique(a), unique(b)]:
        for rank, item in enumerate(ranking, 1):
            scores[item] = scores.get(item, 0) + 1 / (60 + rank)
    return sorted(scores, key=lambda item: (-scores[item], item))

class Index:
    def __init__(self, corpus, name):
        self.root = WORK / name
        self.root.mkdir(parents=True, exist_ok=False)
        self.records = {r['id']: r for r in corpus['records']}
        self.tok = tokenizer()
        self.passages, self.files = {}, {}
        self.client = self.native = None
        import jieba
        jieba.dt.tmp_dir = str(self.root)
        jieba.initialize()
        for r in self.records.values():
            path = self.root / 'canonical' / r['project'] / (r['id'] + '.md')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(r['content'], encoding='utf-8')
            self.files[r['id']] = {'path': str(path), 'sha256': digest(path)}
            title = r['title']
            encoded = self.tok.encode(title, add_special_tokens=False)
            if len(encoded.ids) > 48:
                title = title[:encoded.offsets[47][1]]
            for number, piece in enumerate(split_body(r['content'], self.tok)):
                pid = 'p-' + hashlib.sha256(f'{r["id"]}/{number}/{piece["start"]}/{piece["end"]}'.encode()).hexdigest()[:16]
                p = {**piece, 'id': pid, 'title': title, 'memoryId': r['id'],
                     'project': r['project'], 'status': r['status']}
                assert len(p['text']) < 3000 and '\x00' not in p['text']
                self.passages[pid] = p
                note = self.root / 'bm/notes' / r['project'] / (pid + '.md')
                note.parent.mkdir(parents=True, exist_ok=True)
                note.write_text('---\ntitle: ' + json.dumps(title, ensure_ascii=False) +
                                f'\ntype: note\npermalink: {pid}\n---\n\n{piece["text"]}\n', encoding='utf-8')
        self.state = self.root / 'bm'
        config = json.loads((ROOT / '.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
        config.update({'projects': {p: {'path': str(self.state / 'notes' / p), 'mode': 'local'}
                                   for p in sorted({r['project'] for r in self.records.values()})},
                       'semantic_vector_k': 500, 'auto_update': False, 'reranker_enabled': False})
        bm.save(self.state / 'config/config.json', config)
        bm.save(self.root / 'passages.json', {'files': self.files, 'passages': self.passages})

    def prepare_bm(self):
        began = time.perf_counter()
        try:
            self.client = bm.Mcp(self.state, 'hybrid')
            self.bm_initialize_ms = self.client.initialize_ms
            deadline = time.monotonic() + 900
            while True:
                con = None
                try:
                    con = sqlite3.connect((self.state / 'config/memory.db').resolve().as_uri() + '?mode=ro', uri=True)
                    con.enable_load_extension(True)
                    sqlite_vec.load(con)
                    ready = {r[0] for r in con.execute("SELECT e.permalink FROM entity e JOIN search_vector_chunks c ON c.entity_id=e.id GROUP BY e.id HAVING min(c.embedding_status='ready')=1")}
                    pending = con.execute("SELECT count(*) FROM search_vector_chunks WHERE embedding_status!='ready'").fetchone()[0]
                except sqlite3.OperationalError:
                    ready, pending = set(), -1
                finally:
                    if con:
                        con.close()
                missing = set(self.passages) - ready
                bm.save(self.root / 'readiness.json', {'expected': len(self.passages), 'ready': len(set(self.passages) & ready),
                                                      'pending': pending, 'missingCount': len(missing), 'ms': (time.perf_counter() - began)*1000})
                if not missing and pending == 0:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError('Bounded indexing readiness exceeded900s')
                time.sleep(2)
            con = sqlite3.connect((self.state / 'config/memory.db').resolve().as_uri() + '?mode=ro', uri=True)
            snippets = con.execute("SELECT e.permalink,s.content_snippet FROM entity e JOIN search_index s ON s.entity_id=e.id AND s.type='entity'").fetchall()
            assert {pid for pid, text in snippets} == set(self.passages)
            for pid, text in snippets:
                assert text.strip().replace('\r\n','\n') == self.passages[pid]['text'].strip().replace('\r\n','\n'), 'BM parser changed facts beyond line endings'
            # Export *all* semantic rows, including observations/relations, so their
            # global-K competition is identical. Query output remains entity-only.
            self.chunks = [{'id': cid, 'pid': pid, 'key': key, 'text': text, 'project': self.passages[pid]['project']}
                           for cid, pid, key, text in con.execute("SELECT c.id,e.permalink,c.chunk_key,c.chunk_text FROM search_vector_chunks c JOIN entity e ON e.id=c.entity_id ORDER BY c.id")]
            con.close()
            bm.save(self.root / 'common-semantic-inputs.json', self.chunks)
            self.bm_prepare_ms = (time.perf_counter() - began)*1000
            self.bm_resources = self.client.usage()
        except BaseException:
            self.close()
            raise

    def prepare_native_vectors(self):
        from fastembed import TextEmbedding
        began = time.perf_counter()
        self.embedding = TextEmbedding(model_name='BAAI/bge-small-zh-v1.5', threads=2,
            cache_dir=str(ROOT / '.local/hbm-00/cache/models'), local_files_only=True, enable_cpu_mem_arena=False)
        self.native = sqlite3.connect(self.root / 'native.sqlite3')
        self.native.enable_load_extension(True)
        sqlite_vec.load(self.native)
        self.native.enable_load_extension(False)
        self.native.executescript('CREATE TABLE manifest(cid INTEGER PRIMARY KEY,pid TEXT,kind TEXT,project TEXT); CREATE VIRTUAL TABLE vectors USING vec0(embedding float[512]);')
        vectors = self.embedding.embed([c['text'] for c in self.chunks], batch_size=64)
        for chunk, vector in zip(self.chunks, vectors, strict=True):
            v = self.normalized(vector)
            self.native.execute('INSERT INTO manifest VALUES(?,?,?,?)', (chunk['id'], chunk['pid'], chunk['key'].split(':')[0], chunk['project']))
            self.native.execute('INSERT INTO vectors(rowid,embedding) VALUES(?,?)', (chunk['id'], sqlite_vec.serialize_float32(v)))
        self.native.commit()
        self.native_prepare_ms = (time.perf_counter() - began)*1000
        # Audit actual independently computed vectors against BM; never copy them.
        con = sqlite3.connect((self.state / 'config/memory.db').resolve().as_uri()+'?mode=ro', uri=True)
        con.enable_load_extension(True)
        sqlite_vec.load(con)
        import numpy as np
        max_delta = 0.0
        for chunk in self.chunks:
            a = self.native.execute('SELECT embedding FROM vectors WHERE rowid=?', (chunk['id'],)).fetchone()[0]
            b = con.execute('SELECT embedding FROM search_vector_embeddings WHERE rowid=?', (chunk['id'],)).fetchone()[0]
            max_delta = max(max_delta, float(np.max(np.abs(np.frombuffer(a, dtype='<f4')-np.frombuffer(b, dtype='<f4')))))
        con.close()
        self.embedding_audit = {'inputs': len(self.chunks), 'maxAbsoluteComponentDelta': max_delta,
                                'tolerance': 1e-5, 'storedVectorsCopied': False,
                                'representationProducer': 'BM parser export shared by both fixtures; not independent parser comparison'}
        assert max_delta <= 1e-5, 'Embedding representation mismatch; comparison cannot proceed'
        bm.save(self.root / 'embedding-parity.json', self.embedding_audit)

    @staticmethod
    def normalized(vector):
        values = [float(x) for x in vector]
        norm = math.sqrt(sum(x*x for x in values))
        return [x/norm for x in values] if norm else values

    def native_input(self, questions, name):
        path = self.root / (name + '-native-input.json')
        data = {'format': 'hbm-parity-native-input-v1', 'projects': sorted({r['project'] for r in self.records.values()}),
                'passages': list(self.passages.values()), 'queries': [
                    {'id': q['id'], 'project': q['project'], 'lexicalQuery': ' '.join(terms(q['query']))} for q in questions]}
        with path.open('x', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False)
        return path

    def native_lexical(self, questions, harness, name):
        source = self.native_input(questions, name)
        output = self.root / (name + '-native-output.json')
        env = os.environ.copy()
        env.update({'HUB_MEMORY_PARITY_INPUT': str(source), 'HUB_MEMORY_PARITY_OUTPUT': str(output),
                    'TEMP': str(WORK / 'tmp'), 'TMP': str(WORK / 'tmp')})
        assert digest(harness['executable']) == harness['binarySha256']
        began = time.perf_counter()
        with (self.root / (name + '-native.log')).open('xb') as log:
            process = subprocess.Popen([harness['executable'], '--ignored', '--exact',
                'agent_work::memory_selection_tests::native_sqlite_tantivy_passage_parity', '--test-threads=1'],
                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                code = process.wait(timeout=600)
            except BaseException:
                process.terminate(); process.wait(timeout=10)
                raise
        assert code == 0, 'Native opt-in test failed; retained exact log'
        data = json.loads(output.read_text(encoding='utf-8'))
        assert data['inputSha256'] == digest(source) and len(data['results']) == len(questions)
        assert not Path(data['fixtureRoot']).exists(), 'Owned native fixture was not closed'
        self.lexical_receipt = {**data, 'wallMs': (time.perf_counter()-began)*1000, 'exitCode': code}
        return {r['id']: r for r in data['results']}

    def vector_search(self, query, project, backend):
        began = time.perf_counter()
        if backend == 'basic-memory-hybrid':
            hits = bm.results_from(self.client.call('search_notes', {'query': query, 'project': project,
                'search_all_projects': False, 'search_type': 'vector', 'min_similarity': 0.0,
                'page_size': 50, 'entity_types': ['entity'], 'output_format': 'json'}))
            ids = [bm.hit_identity(hit) for hit in hits]
        else:
            vector = self.normalized(next(self.embedding.embed([query], batch_size=64)))
            rows = self.native.execute('WITH nearest AS MATERIALIZED (SELECT rowid,distance FROM vectors WHERE embedding MATCH ? AND k=500) SELECT m.pid,m.kind,n.distance FROM nearest n JOIN manifest m ON m.cid=n.rowid WHERE m.project=? ORDER BY n.distance,m.cid', (sqlite_vec.serialize_float32(vector), project)).fetchall()
            ids = unique([pid for pid, kind, distance in rows if kind == 'entity'])[:50]
        assert all(pid in self.passages for pid in ids), 'Unknown passage returned'
        # BM entity limit is before Hub authority filtering; mirror on both sides.
        excluded = [pid for pid in ids if self.passages[pid]['project'] != project or self.passages[pid]['status'] != 'confirmed']
        eligible = [pid for pid in ids if pid not in excluded]
        return {'passages': eligible, 'rawPassages': ids, 'excluded': excluded, 'ms': (time.perf_counter()-began)*1000}

    def retrieve(self, question, lexical, backend):
        vec = self.vector_search(question['query'], question['project'], backend)
        lex = lexical['ids']
        parent = lambda ids: unique(self.passages[pid]['memoryId'] for pid in ids)
        ranked = fuse(parent(vec['passages']), parent(lex))[:20]
        passage_order = fuse(vec['passages'], lex)
        by_parent = {}
        for pid in passage_order:
            by_parent.setdefault(self.passages[pid]['memoryId'], []).append(pid)
        candidates = []
        for mid in ranked[:5]:
            assert digest(self.files[mid]['path']) == self.files[mid]['sha256']
            p = self.passages[by_parent[mid][0]]
            r = self.records[mid]
            candidates.append({'id': mid, 'title': r['title'], 'project': r['project'], 'status': r['status'], 'text': p['text']})
        dropped = []
        while len(self.tok.encode(json.dumps(candidates, ensure_ascii=False), add_special_tokens=False).ids) > 2000:
            dropped.append(candidates.pop()['id'])
        return {'fused': ranked, 'vector': parent(vec['passages'])[:20], 'lexical': parent(lex)[:20],
                'vectorPassages': vec['passages'], 'lexicalPassages': lex, 'passageIds': by_parent,
                'excluded': unique(vec['excluded'] + lexical['excluded']),
                'retrievalMs': vec['ms'] + lexical['elapsedMs'], 'vectorMs': vec['ms'],
                'candidates': candidates, 'budgetDropped': dropped,
                'memoryBgeTokens': len(self.tok.encode(json.dumps(candidates, ensure_ascii=False), add_special_tokens=False).ids)}

    def close(self):
        if self.native is not None:
            self.native.close(); self.native = None
        if self.client is not None and not self.client.stderr.closed:
            self.client.close()

