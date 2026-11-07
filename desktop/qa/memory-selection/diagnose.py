"""HBM-00 controlled retrieval diagnosis. No production memory integration."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/diagnostics-20261018'
REPORTS = ROOT / 'artifacts/hbm-00-diagnostics-20261018'
CORPUS = Path(__file__).with_name('corpus.json')
EXPECTED_HASH = 'f1863d81f07bf1997fefdd23a97dc597e5ad276079bb050f3d1b965e3266440b'
PREFIX = '为这个句子生成表示以用于检索相关文章：'
os.environ['HF_HOME'] = str(ROOT / '.local/hbm-00/cache/huggingface')
os.environ['FASTEMBED_CACHE_PATH'] = str(ROOT / '.local/hbm-00/cache/models')
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def save(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / name
    if path.exists():
        raise FileExistsError(f'Keep prior evidence; refusing overwrite: {path}')
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def corpus():
    if hashlib.sha256(CORPUS.read_bytes()).hexdigest() != EXPECTED_HASH:
        raise ValueError('Frozen corpus identity changed')
    WORK.mkdir(parents=True, exist_ok=True)
    return json.loads(CORPUS.read_text(encoding='utf-8'))


def measure(data, rows):
    from summarize import evaluate
    value = evaluate(data, {'results': rows})
    value.pop('failures')
    return value


def freeze():
    data = corpus()
    save('contract.json', {
        'format': 'hub-hbm-retrieval-diagnosis-v1', 'corpusSha256': EXPECTED_HASH,
        'scope': 'HBM-00 only; no backend choice, production change, or later batches',
        'gatesUnchanged': {'recallAt5': .9, 'selectedPrecision': .8, 'negativeCases': 0, 'scopeStateViolations': 0},
        'topK': 5, 'rawLimit': 20, 'originalCosineGate': .65,
        'ablations': ['same weights: raw ranking vs .65 admission', 'same weights: query instruction vs no instruction', 'same Unicode61 FTS: unsegmented vs jieba 0.42.1 search segmentation', 'same index: whole query AND vs segmented OR keyword strategy', 'conditional alternate model if ranking still misses: multilingual MiniLM L12 v2'],
        'diagnosticThresholdSweep': [.45, .5, .55, .6, .65, .7, .75],
        'calibration': 'Lexical positive queries and q41-q46 unrelated; paraphrase positives and q47-q52 validate. All 8 isolation cases checked separately. Previously observed data: not a blind external test.',
        'queryRules': 'Generic tokenizer, POS/stopword filtering only; query generation cannot read expected IDs or corpus documents; no per-question synonym map',
        'limits': {'threads': 2, 'newModelMaxGiB': .7, 'managedDiskMaxGiB': 8, 'newModelDownloadTimeoutSeconds': 180, 'noModelGenerationCalls': True},
        'inputs': {'records': len(data['records']), 'queries': len(data['queries'])},
        'officialReferences': ['https://huggingface.co/BAAI/bge-small-zh-v1.5', 'https://www.sqlite.org/fts5.html#unicode61_tokenizer'],
        'oldReportsUntouched': 'artifacts/hbm-00-20261018', 'createdAt': time.time(),
    })
    print('Frozen diagnosis contract: 60 original queries; no backend selection')


def vectors(model_name, query_path=None):
    import numpy as np
    import psutil
    from fastembed import TextEmbedding
    data = corpus()
    questions = json.loads(Path(query_path).read_text(encoding='utf-8'))['queries'] if query_path else data['queries']
    assert [q['id'] for q in questions] == [q['id'] for q in data['queries']]
    began = time.perf_counter()
    model = TextEmbedding(model_name=model_name, threads=2, cache_dir=str(ROOT / '.local/hbm-00/cache/models'))
    bodies = [f'# {record["title"]}\n\n{record["content"]}' for record in data['records']]
    docs = np.asarray(list(model.embed(bodies)))
    docs /= np.linalg.norm(docs, axis=1, keepdims=True)
    init_ms = (time.perf_counter() - began) * 1000
    variants = {}
    all_scores = {}
    prefix_modes = [('plain', '')] + ([('instruction', PREFIX)] if model_name.startswith('BAAI/') else [])
    for name, prefix in prefix_modes:
        started = time.perf_counter()
        queries = np.asarray(list(model.embed([prefix + (q['searchText'] if query_path else q['query']) for q in questions])))
        queries /= np.linalg.norm(queries, axis=1, keepdims=True)
        elapsed = (time.perf_counter() - started) * 1000 / len(queries)
        scores = queries @ docs.T
        all_scores[name] = scores.tolist()
        for threshold in [None, .45, .5, .55, .6, .65, .7, .75]:
            rows = []
            for question, values in zip(data['queries'], scores):
                ranked = sorted(range(len(values)), key=lambda index: -float(values[index]))
                raw = [i for i in ranked if data['records'][i]['project'] == question['project']][:20]
                chosen = [i for i in raw if data['records'][i]['status'] == 'confirmed' and (threshold is None or float(values[i]) >= threshold)][:5]
                eligible = [i for i in raw if data['records'][i]['status'] == 'confirmed']
                expected = [i for i in ranked if data['records'][i]['id'] in question['expected']]
                rows.append({'id': question['id'], 'ids': [data['records'][i]['id'] for i in chosen], 'elapsedMs': elapsed, 'topScores': [{'id': data['records'][i]['id'], 'score': float(values[i])} for i in eligible[:5]], 'expectedRank': next((eligible.index(i) + 1 for i in expected if i in eligible), None), 'expectedScore': float(values[expected[0]]) if expected else None})
            key = name + ('-rank-only' if threshold is None else f'-threshold-{threshold}')
            variants[key] = {'metrics': measure(data, rows), 'results': rows}
    label = ('bge' if model_name.startswith('BAAI/') else 'minilm') + ('-normalized' if query_path else '')
    save(f'vectors-{label}.json', {'format': 'hub-hbm-vector-diagnosis-v1', 'corpusSha256': EXPECTED_HASH, 'model': model_name, 'dimensions': int(docs.shape[1]), 'queryInputSha256': hashlib.sha256(Path(query_path).read_bytes()).hexdigest() if query_path else None, 'initializeAndEmbedDocsMs': init_ms, 'rssMiB': psutil.Process().memory_info().rss / 1024**2, 'variants': variants, 'allScores': all_scores, 'recordOrder': [r['id'] for r in data['records']], 'methodLimit': 'Direct FastEmbed normalized cosine with original native body serialization; BM chunking is checked separately over MCP. Rank-only is diagnostic and cannot authorize injection. elapsedMs in rows is a batch mean, not individually measured P95.'})
    print(json.dumps({'model': model_name, 'metrics': {name: value['metrics'] for name, value in variants.items() if 'rank-only' in name or name.endswith('0.65')}}, ensure_ascii=False))


def lexical():
    import jieba
    data = corpus()
    jieba.dt.tmp_dir = str(WORK)
    c = sqlite3.connect(WORK / 'lexical.sqlite3')
    c.executescript("CREATE VIRTUAL TABLE raw USING fts5(id UNINDEXED,title,body,tokenize='unicode61 tokenchars 0x2F'); CREATE VIRTUAL TABLE segmented USING fts5(id UNINDEXED,title,body,tokenize='unicode61 tokenchars 0x2F'); CREATE VIRTUAL TABLE vocabulary USING fts5vocab(raw,'row');")
    for record in data['records']:
        c.execute('INSERT INTO raw VALUES(?,?,?)', (record['id'], record['title'], record['content']))
        c.execute('INSERT INTO segmented VALUES(?,?,?)', (record['id'], ' '.join(jieba.cut_for_search(record['title'])), ' '.join(jieba.cut_for_search(record['content']))))
    c.commit()
    vocab = [row[0] for row in c.execute('SELECT term FROM vocabulary ORDER BY term')]
    variants = {}
    manifest = {record['id']: record for record in data['records']}
    for table in ['raw', 'segmented']:
        for mode in ['and', 'or']:
            rows = []
            for question in data['queries']:
                began = time.perf_counter()
                tokens = list(dict.fromkeys(token.strip().lower() for token in (jieba.cut_for_search(question['query']) if table == 'segmented' else question['query'].split()) if re.search(r'[\w\u4e00-\u9fff]', token)))
                rendered = (' AND ' if mode == 'and' else ' OR ').join('"' + token.replace('"', '""') + '"*' for token in tokens)
                found = c.execute(f'SELECT id,bm25({table},0,8,1) AS score FROM {table} WHERE {table} MATCH ? ORDER BY score LIMIT 20', (rendered,)).fetchall() if rendered else []
                ids = [key for key, _ in found if manifest[key]['status'] == 'confirmed' and manifest[key]['project'] == question['project']][:5]
                rows.append({'id': question['id'], 'ids': ids, 'queryTokens': tokens, 'renderedQuery': rendered, 'elapsedMs': (time.perf_counter() - began) * 1000})
            variants[table + '-' + mode] = {'metrics': measure(data, rows), 'results': rows}
    save('lexical.json', {'format': 'hub-hbm-lexical-ablation-v1', 'corpusSha256': EXPECTED_HASH, 'sqliteVersion': sqlite3.sqlite_version, 'jiebaVersion': jieba.__version__, 'vocabulary': vocab, 'variants': variants, 'methodLimit': 'Standalone same SQLite Unicode61 tokenizer; not a fork or production modification of Basic Memory. Query and document segmentation are a controlled prototype.'})
    c.close()
    print(json.dumps({key: value['metrics'] for key, value in variants.items()}, ensure_ascii=False))


def treatments():
    import jieba
    from query_policy import keywords, render
    data = corpus()
    jieba.dt.tmp_dir = str(WORK)
    save('treatment-contract.json', {
        'format': 'hub-hbm-retrieval-treatment-v1', 'corpusSha256': EXPECTED_HASH,
        'reason': '95% raw top-5 vs 47.5% after .65; segmented OR recalls 92.5% but admits negatives. Separate candidate retrieval and relevance admission.',
        'queryPolicySha256': hashlib.sha256(Path(__file__).with_name('query_policy.py').read_bytes()).hexdigest(),
        'candidateVariants': ['Hub actual EvidenceReader keyword AND', 'Hub actual EvidenceReader keyword OR', 'Basic Memory MCP original / keyword AND / keyword OR; same original index'],
        'embeddingAdmission': 'Raw score and rank retained; calibrated score/margin/top-K policy selected on lexical positives plus q41-q46 only, evaluated on paraphrases plus q47-q52 and all isolation guards. No post-validation tuning.',
        'originalQuestionsAndGoldUnchanged': True, 'productionSearchChanged': False,
    })
    for operator in ['AND', 'OR']:
        questions = [{**question, 'originalQuery': question['query'], 'query': render(question['query'], operator)} for question in data['queries']]
        save(f'queries-keyword-{operator.lower()}.json', {'variant': 'keyword-' + operator.lower(), 'queries': questions})
    save('query-analysis.json', [{'id': q['id'], 'original': q['query'], 'keywords': keywords(q['query'])} for q in data['queries']])
    print('Frozen two query-only treatments; original gold and first-round receipts unchanged')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['freeze', 'vectors', 'lexical', 'treatments'])
    parser.add_argument('--model', default='BAAI/bge-small-zh-v1.5')
    parser.add_argument('--queries')
    args = parser.parse_args()
    {'freeze': freeze, 'vectors': lambda: vectors(args.model, args.queries), 'lexical': lexical, 'treatments': treatments}[args.phase]()
