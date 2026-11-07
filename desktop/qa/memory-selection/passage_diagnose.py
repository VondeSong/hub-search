"""Read-only inspection of the prior isolated BM index; no personal database."""
import argparse
import hashlib
import json
import sqlite3
import sqlite_vec
from pathlib import Path

from passage_support import ROOT, WORK, PREVIOUS, save, digest


def inspect():
    path = ROOT / '.local/hbm-00/independent-20261018/basic-memory/config/memory.db'
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    connection.enable_load_extension(True)
    sqlite_vec.load(connection)
    tables = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    columns = {name: [r[1] for r in connection.execute(f'PRAGMA table_info("{name}")')]
               for name in tables if any(w in name for w in ['chunk', 'vector', 'embedding', 'entity', 'search_index'])}
    save('db-schema-inspection.json', {'database': str(path), 'readOnly': True,
                                        'tables': tables, 'columns': columns,
                                        'previousCorpusSha256': digest(PREVIOUS / 'corpus.json')})
    print(json.dumps(columns, ensure_ascii=False, indent=2))


def audit():
    import os
    os.environ['HF_HOME'] = str(ROOT / '.local/hbm-00/cache/huggingface')
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    import numpy as np
    from fastembed import TextEmbedding
    from tokenizers import Tokenizer

    corpus = json.loads((PREVIOUS / 'corpus.json').read_text(encoding='utf-8'))
    summary = json.loads((PREVIOUS / 'summary.json').read_text(encoding='utf-8'))
    question = summary['errors'][0]
    target = next(r for r in corpus['records'] if r['id'] == question['expected'][0])
    path = ROOT / '.local/hbm-00/independent-20261018/basic-memory/config/memory.db'
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    connection.enable_load_extension(True)
    sqlite_vec.load(connection)
    entity_id, project_id = connection.execute('SELECT id,project_id FROM entity WHERE permalink=?', (target['id'],)).fetchone()
    source_rows = connection.execute('SELECT id,type,content_snippet FROM search_index WHERE entity_id=?', (entity_id,)).fetchall()
    chunk_rows = connection.execute('SELECT id,chunk_key,chunk_text,embedding_status,source_hash FROM search_vector_chunks WHERE entity_id=?', (entity_id,)).fetchall()
    model = TextEmbedding(model_name='BAAI/bge-small-zh-v1.5', threads=2,
                          cache_dir=str(ROOT / '.local/hbm-00/cache/models'), enable_cpu_mem_arena=False)
    tokenizer = model.model.tokenizer
    unlimited = Tokenizer.from_str(tokenizer.to_str())
    unlimited.no_truncation()
    unlimited.no_padding()
    truncated = Tokenizer.from_str(tokenizer.to_str())
    truncated.no_padding()
    metadata = {'requestedQuestion': question['question'], 'targetId': target['id'],
                'canonicalBodyLength': len(target['content']), 'bodyContainsFact': '16:9' in target['content'],
                'tokenizerTruncation': tokenizer.truncation, 'sourceRows': [], 'chunks': []}
    for ident, kind, snippet in source_rows:
        metadata['sourceRows'].append({'id': ident, 'kind': kind, 'length': len(snippet),
                                       'containsFact': '16:9' in snippet})
    for ident, key, text, status, sha in chunk_rows:
        full = unlimited.encode(text)
        clipped = truncated.encode(text)
        visible_end = max(end for start, end in clipped.offsets)
        fact_start = text.find('16:9')
        blob = connection.execute('SELECT embedding FROM search_vector_embeddings WHERE rowid=?', (ident,)).fetchone()[0]
        stored = np.frombuffer(blob, dtype=np.float32)
        again = np.asarray(next(model.embed([text])))
        again /= np.linalg.norm(again)
        metadata['chunks'].append({'rowId': ident, 'chunkKey': key, 'characters': len(text),
                                   'fullTokens': len(full.ids), 'embeddedTokens': len(clipped.ids),
                                   'visibleCharacterEnd': visible_end, 'factCharacterStart': fact_start,
                                   'factActuallyVisibleToEmbedding': fact_start >= 0 and fact_start+4 <= visible_end,
                                   'embeddingStatus': status, 'sourceHash': sha,
                                   'storedReembeddingMaxAbsError': float(np.max(np.abs(stored-again))),
                                   'text': text})
    # Same model/query and actual stored vectors: recover the complete rank, not only top 20.
    qvector = np.asarray(next(model.embed([question['question']])))
    qvector /= np.linalg.norm(qvector)
    chunks = connection.execute('SELECT c.id,c.entity_id,c.chunk_text,e.permalink,v.embedding FROM search_vector_chunks c JOIN entity e ON e.id=c.entity_id JOIN search_vector_embeddings v ON v.rowid=c.id WHERE c.project_id=?', (project_id,)).fetchall()
    by_entity = {}
    for ident, owner, text, permalink, blob in chunks:
        score = float(np.dot(qvector, np.frombuffer(blob, dtype=np.float32)))
        if permalink not in by_entity or score > by_entity[permalink]['score']:
            by_entity[permalink] = {'id': permalink, 'score': score, 'chunkId': ident}
    ranked = sorted(by_entity.values(), key=lambda r: (-r['score'],r['id']))
    metadata['storedVectorRanking'] = ranked
    metadata['targetStoredRank'] = next(i+1 for i,r in enumerate(ranked) if r['id']==target['id'])
    metadata['readOnly'] = True
    save('long-record-audit.json', metadata)
    print(json.dumps({k:v for k,v in metadata.items() if k not in ['storedVectorRanking','chunks']}, ensure_ascii=False))
    print(json.dumps({'chunks': [{k:v for k,v in r.items() if k!='text'} for r in metadata['chunks']]}, ensure_ascii=False))


def ablation():
    import os
    os.environ['HF_HOME']=str(ROOT/'.local/hbm-00/cache/huggingface')
    import numpy as np
    from fastembed import TextEmbedding
    audit=json.loads((ROOT/'artifacts/hbm-00-passages-20261018/long-record-audit.json').read_text(encoding='utf-8'))
    corpus=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    target=next(r for r in corpus['records'] if r['id']==audit['targetId'])
    text=audit['chunks'][0]['text']
    assert target['content'] in text
    unchanged_prefix=text[:text.index(target['content'])]
    paragraphs=[part for part in target['content'].split('\n\n') if part.strip()]
    model=TextEmbedding(model_name='BAAI/bge-small-zh-v1.5',threads=2,
        cache_dir=str(ROOT/'.local/hbm-00/cache/models'),enable_cpu_mem_arena=False,local_files_only=True)
    query=np.asarray(next(model.embed([audit['requestedQuestion']])))
    query/=np.linalg.norm(query)
    scores=[]
    for paragraph,vector in zip(paragraphs,model.embed([unchanged_prefix+p for p in paragraphs])):
        vector=np.asarray(vector);vector/=np.linalg.norm(vector)
        scores.append({'paragraphSha256':hashlib.sha256(paragraph.encode()).hexdigest(),
                       'containsRequestedFact':'16:9' in paragraph,'score':float(np.dot(query,vector))})
    best=max(s['score'] for s in scores)
    rivals=[r['score'] for r in audit['storedVectorRanking'] if r['id']!=target['id']]
    new_rank=1+sum(score>best for score in rivals)
    save('long-record-ablation.json',{'status':'completed','questionUnchanged':True,'modelUnchanged':True,
        'titlePermalinkPrefixUnchanged':True,'otherEntityVectorsUnchanged':True,
        'baselineTargetRank':audit['targetStoredRank'],'paragraphMaxTargetRank':new_rank,
        'baselineScore':next(r['score'] for r in audit['storedVectorRanking'] if r['id']==target['id']),
        'paragraphScores':scores,'interpretation':'Only semantic packing changes: same metadata prefix and exact original paragraphs, no new facts. All paragraphs are represented; max matches generic passage retrieval.',
        'methodLimit':'Single known development failure is causal diagnosis, not a new validation score.'})
    print(json.dumps({'baselineRank':audit['targetStoredRank'],'paragraphMaxRank':new_rank,'paragraphScores':scores},ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['inspect', 'audit','ablation'])
    args = parser.parse_args()
    {'inspect': inspect, 'audit': audit,'ablation':ablation}[args.phase]()
