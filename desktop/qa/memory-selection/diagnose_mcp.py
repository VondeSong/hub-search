"""Check the query treatments through actual Basic Memory MCP in a fresh root."""
import hashlib
import json
from pathlib import Path
import time

import run as bm
from diagnose import ROOT, WORK, REPORTS, EXPECTED_HASH, corpus, measure, save

data = corpus()
normalized_path = REPORTS / 'queries-normalized.json'
normalized = json.loads(normalized_path.read_text(encoding='utf-8'))
keyword_path = REPORTS / 'queries-keyword-or.json'
keyword = json.loads(keyword_path.read_text(encoding='utf-8'))
state = WORK / 'basic-memory'
state.mkdir(parents=True, exist_ok=False)
settings = json.loads((ROOT / '.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
settings['projects'] = {name: {'path': str(state / 'notes' / name), 'mode': 'local'} for name in ['hub', 'other', 'private']}
for item in data['records']:
    path = state / 'notes' / item['project'] / (item['id'] + '.md')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'---\ntitle: {item["title"]}\ntype: note\npermalink: {item["id"]}\nhub_id: {item["id"]}\nhub_status: {item["status"]}\n---\n\n# {item["title"]}\n\n{item["content"]}\n', encoding='utf-8')
bm.save(state / 'config/config.json', settings)
variants = [
    ('original-text', 'text', data['queries'], 'query', .65),
    ('keyword-or-text', 'text', keyword['queries'], 'query', .65),
    ('normalized-or-text', 'text', normalized['queries'], 'query', .65),
    ('original-vector-rank', 'vector', data['queries'], 'query', 0.0),
    ('original-hybrid', 'hybrid', data['queries'], 'query', .65),
    ('normalized-vector', 'vector', normalized['queries'], 'searchText', .65),
    ('normalized-hybrid', 'hybrid', normalized['queries'], 'searchText', .65),
]
save('mcp-contract.json', {'format': 'hub-hbm-mcp-diagnosis-contract-v1', 'corpusSha256': EXPECTED_HASH, 'queryInputs': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [normalized_path, keyword_path]}, 'variants': [{'name': name, 'searchType': search_type, 'queryField': field, 'minSimilarity': threshold} for name, search_type, _, field, threshold in variants], 'schema': 'Unchanged Basic Memory 0.23.2 + BGE small Chinese 512d; fresh local project. No production Hub integration.'})
manifest = {record['id']: record for record in data['records']}
receipt = {'format': 'hub-hbm-mcp-diagnosis-v1', 'corpusSha256': EXPECTED_HASH, 'status': 'starting', 'variants': {}}
client = None
try:
    client = bm.Mcp(state, 'hybrid')
    receipt['initializeMs'] = client.initialize_ms
    bm.wait_ready(client, data, 'hybrid', receipt, WORK / 'mcp-progress.json')
    for name, search_type, questions, field, threshold in variants:
        rows = []
        for question in questions:
            query = question[field]
            began = time.perf_counter()
            hits = bm.results_from(client.call('search_notes', {'query': query, 'project': question['project'], 'search_all_projects': False, 'search_type': search_type, 'page_size': 20, 'entity_types': ['entity'], 'min_similarity': threshold, 'output_format': 'json'})) if query.strip() else []
            ids, ranked = [], []
            for hit in hits:
                key = bm.hit_identity(hit)
                record = manifest.get(key)
                ranked.append({'id': key, 'score': hit.get('score'), 'scoreType': hit.get('score_type'), 'sourceType': hit.get('type')})
                if not record or record['project'] != question['project'] or record['status'] != 'confirmed' or key in ids:
                    continue
                source = state / 'notes' / record['project'] / (key + '.md')
                if record['content'] not in source.read_text(encoding='utf-8'):
                    raise ValueError('Canonical content changed during diagnosis')
                if len(ids) < 5:
                    ids.append(key)
            rows.append({'id': question['id'], 'ids': ids, 'rawCandidates': ranked, 'elapsedMs': (time.perf_counter() - began) * 1000})
        receipt['variants'][name] = {'results': rows, 'metrics': measure(data, rows)}
        bm.save(WORK / 'mcp-progress.json', receipt)
        print(json.dumps({'variant': name, 'metrics': receipt['variants'][name]['metrics']}, ensure_ascii=False), flush=True)
    receipt['usageAtEnd'] = client.usage()
    receipt['status'] = 'completed'
except BaseException as error:
    receipt['status'] = 'failed'
    receipt['error'] = str(error)[:2000]
    raise
finally:
    if client:
        client.close()
        receipt['residual'] = client.residual
        receipt['processExitCode'] = client.process.returncode
    save('mcp.json', receipt)
