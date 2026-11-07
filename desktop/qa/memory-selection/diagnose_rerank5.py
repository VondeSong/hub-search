"""Reduce candidate count with the already frozen admission policy; do not refit."""
import json
import math
import statistics
import time

from diagnose import ROOT, REPORTS, EXPECTED_HASH, corpus, measure, save

data = corpus()
prior = json.loads((REPORTS / 'rerank.json').read_text(encoding='utf-8'))
policy = prior['selectedPolicy']
grid = json.loads((REPORTS / 'rerank-contract.json').read_text(encoding='utf-8'))['grid']
save('rerank5-contract.json', {'format': 'hub-hbm-rerank5-contract-v1', 'corpusSha256': EXPECTED_HASH, 'candidateLimit': 5, 'model': 'Same cached BGE reranker INT8', 'admissionPolicyUnchanged': policy, 'calibrationPasses': 0, 'reason': '20-candidate rerank alone has measured P95 >1s; test the direct latency/recall tradeoff of the existing raw top-5', 'gridScope': 'Previously declared threshold grid published as sensitivity analysis only, no replacement of frozen validation or adoption based on full-set scores'})

import psutil
from fastembed.rerank.cross_encoder import TextCrossEncoder

began = time.perf_counter()
model = TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8', threads=2, cache_dir=str(ROOT / '.local/hbm-00/cache/models'))
initialize_ms = (time.perf_counter() - began) * 1000
manifest = {r['id']: r for r in data['records']}
ranked = []
for question, source in zip(data['queries'], prior['rankedScores']):
    keys = source['candidateIds'][:5]
    documents = [f'# {manifest[key]["title"]}\n\n{manifest[key]["content"]}' for key in keys]
    began = time.perf_counter()
    scores = list(model.rerank(question['query'], documents, batch_size=5))
    elapsed = (time.perf_counter() - began) * 1000
    ranked.append({'id': question['id'], 'scores': sorted([{'id': key, 'probability': 1 / (1 + math.exp(-max(-80, min(80, float(score)))))} for key, score in zip(keys, scores)], key=lambda item: (-item['probability'], item['id'])), 'rerankMs': elapsed})


def rows_for(threshold, top_k):
    return [{'id': row['id'], 'ids': [hit['id'] for hit in row['scores'] if hit['probability'] >= threshold][:top_k], 'elapsedMs': row['rerankMs']} for row in ranked]


sensitivity = {}
for threshold, top_k in grid:
    if top_k == 1:
        sensitivity[str(threshold)] = measure(data, rows_for(threshold, top_k))
times = [row['rerankMs'] for row in ranked]
rows = rows_for(policy['minSigmoidScore'], policy['topK'])
save('rerank5.json', {'format': 'hub-hbm-rerank5-result-v1', 'corpusSha256': EXPECTED_HASH, 'status': 'completed', 'policy': policy, 'initializeFromCachedModelMs': initialize_ms, 'rssMiB': psutil.Process().memory_info().rss / 1024**2, 'allMetrics': measure(data, rows), 'results': rows, 'rankedScores': ranked, 'sensitivityExploratoryOnly': sensitivity, 'rerankTiming': {'medianMs': statistics.median(times), 'p95Ms': statistics.quantiles(times, n=100, method='inclusive')[94]}, 'adoption': 'None; no refit or fresh independent validation'})
print(json.dumps({'metrics': measure(data, rows), 'rerankP95Ms': statistics.quantiles(times, n=100, method='inclusive')[94], 'rssMiB': psutil.Process().memory_info().rss / 1024**2}, ensure_ascii=False))
