"""One bounded cross-encoder treatment on actual MCP top-20 candidate receipts."""
import itertools
import json
import math
from pathlib import Path
import statistics
import time

from diagnose import ROOT, WORK, REPORTS, EXPECTED_HASH, corpus, measure, save

data = corpus()
source = json.loads((REPORTS / 'mcp.json').read_text(encoding='utf-8'))
assert source['status'] == 'completed' and source['corpusSha256'] == EXPECTED_HASH
calibration = {q['id'] for q in data['queries'] if q['expected'] and q['category'] != 'paraphrase'} | {f'q{i:02}' for i in range(41, 47)}
validation = {q['id'] for q in data['queries']} - calibration
grid = list(itertools.product([.01, .025, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, .99], [1, 2, 3, 5]))
save('rerank-contract.json', {'format': 'hub-hbm-rerank-contract-v1', 'corpusSha256': EXPECTED_HASH, 'model': 'BAAI/bge-reranker-v2-m3-int8', 'source': 'FastEmbed registered onnx-community/bge-reranker-v2-m3-ONNX, onnx/model_int8.onnx', 'expectedModelGiB': .57, 'threads': 2, 'candidateSource': 'Actual Basic Memory original-vector-rank MCP results, raw limit 20; existing host project/status/canonical body gates before rerank', 'querySource': 'Original full question, not the normalized rewrite', 'calibrationIds': sorted(calibration), 'validationIds': sorted(validation), 'parameters': ['sigmoid relevance threshold', 'maximum documents'], 'grid': grid, 'selection': 'Calibration precision >=80% and zero negative cases; maximize recall then precision then fewer documents then higher threshold. Validation does not select parameters.', 'stop': 'One reranker and one calibration pass; retain failure, no production integration or backend choice', 'gatesUnchanged': {'recallAt5': .9, 'precision': .8, 'negativeCases': 0, 'scopeStateViolations': 0}, 'officialReference': 'https://huggingface.co/BAAI/bge-reranker-v2-m3'})

import psutil
from fastembed.rerank.cross_encoder import TextCrossEncoder

began = time.perf_counter()
model = TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8', threads=2, cache_dir=str(ROOT / '.local/hbm-00/cache/models'))
initialize_ms = (time.perf_counter() - began) * 1000
manifest = {r['id']: r for r in data['records']}
ranked = []
for question, row in zip(data['queries'], source['variants']['original-vector-rank']['results']):
    assert row['id'] == question['id']
    candidates = []
    for hit in row['rawCandidates']:
        key = hit['id']
        record = manifest.get(key)
        if record and record['project'] == question['project'] and record['status'] == 'confirmed' and key not in candidates:
            path = WORK / 'basic-memory/notes' / record['project'] / (key + '.md')
            assert record['content'] in path.read_text(encoding='utf-8')
            candidates.append(key)
    bodies = [f'# {manifest[key]["title"]}\n\n{manifest[key]["content"]}' for key in candidates]
    start = time.perf_counter()
    scores = list(model.rerank(question['query'], bodies, batch_size=8))
    elapsed = (time.perf_counter() - start) * 1000
    values = sorted([{'id': key, 'logit': float(score), 'probability': 1 / (1 + math.exp(-max(-80, min(80, float(score)))))} for key, score in zip(candidates, scores)], key=lambda item: (-item['logit'], item['id']))
    ranked.append({'id': question['id'], 'scores': values, 'candidateIds': candidates, 'rerankMs': elapsed, 'retrievalMsInSeparateMcpRun': row['elapsedMs']})
    (WORK / 'rerank-progress.json').write_text(json.dumps({'completedQueries': len(ranked), 'lastRerankMs': elapsed}), encoding='utf-8')


def selection(threshold, top_k):
    return [{'id': row['id'], 'ids': [item['id'] for item in row['scores'] if item['probability'] >= threshold][:top_k], 'elapsedMs': row['rerankMs']} for row in ranked]


def quality(rows, identities):
    questions = [q for q in data['queries'] if q['id'] in identities]
    selected = {row['id']: row['ids'] for row in rows}
    positives = [q for q in questions if q['expected']]
    hits = sum(bool(set(q['expected']) & set(selected[q['id']])) for q in positives)
    n = sum(len(selected[q['id']]) for q in questions)
    relevant = sum(len(set(q['expected']) & set(selected[q['id']])) for q in questions)
    return {'positiveQueries': len(positives), 'recallAt5': hits / len(positives), 'selectedContextPrecision': relevant / n if n else 0, 'negativeCases': [q['id'] for q in questions if not q['expected'] and selected[q['id']]]}


qualified = []
for threshold, top_k in grid:
    rows = selection(threshold, top_k)
    q = quality(rows, calibration)
    if q['selectedContextPrecision'] >= .8 and not q['negativeCases']:
        qualified.append((q['recallAt5'], q['selectedContextPrecision'], -top_k, threshold, rows, q))
best = max(qualified, key=lambda item: item[:4]) if qualified else None
raw_rows = [{'id': row['id'], 'ids': [item['id'] for item in row['scores'][:5]], 'elapsedMs': row['rerankMs']} for row in ranked]
candidate_recall = sum(bool(set(q['expected']) & set(row['candidateIds'])) for q, row in zip(data['queries'], ranked) if q['expected']) / 40
times = [row['rerankMs'] for row in ranked]
receipt = {'format': 'hub-hbm-rerank-result-v1', 'corpusSha256': EXPECTED_HASH, 'status': 'completed', 'initializeIncludingFirstDownloadMs': initialize_ms, 'rssMiB': psutil.Process().memory_info().rss / 1024**2, 'candidateRecallAt20': candidate_recall, 'rawRerankAt5': measure(data, raw_rows), 'selectedPolicy': {'minSigmoidScore': best[3], 'topK': -best[2]} if best else None, 'calibration': best[5] if best else None, 'validation': quality(best[4], validation) if best else None, 'allMetrics': measure(data, best[4]) if best else None, 'results': best[4] if best else None, 'rankedScores': ranked, 'rerankTiming': {'medianMs': statistics.median(times), 'p95Ms': statistics.quantiles(times, n=100, method='inclusive')[94]}, 'timingLimit': 'Reranker timing measured in this host; retrieval measured separately in MCP. Not an installed service end-to-end latency gate.', 'backendDecision': 'undecided'}
save('rerank.json', receipt)
print(json.dumps({k: v for k, v in receipt.items() if k not in ['rankedScores', 'results']}, ensure_ascii=False))
