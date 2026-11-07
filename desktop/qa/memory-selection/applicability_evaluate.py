"""Single frozen-set retrieval, unchanged control, and applicability evaluation."""
import argparse
import hashlib
import json
import math
import os
import time

import run as bm
from applicability_policy import POLICY, SCHEMA, validate_decisions
from applicability_support import ROOT, WORK, REPORTS, digest, read, save, model_call

os.environ['HF_HOME'] = str(ROOT / '.local/hbm-00/cache/huggingface')
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def inputs():
    contract = read('validation-contract.json')
    assert digest(REPORTS / 'validation.json') == contract['validationSha256']
    assert digest(REPORTS / 'corpus.json') == contract['corpusSha256']
    assert digest(__import__('pathlib').Path(__file__).with_name('applicability_policy.py')) == contract['policySha256']
    return read('corpus.json'), read('validation.json')['cases']


def retrieve():
    corpus, cases = inputs()
    state = WORK / 'basic-memory'
    state.mkdir(parents=True, exist_ok=False)
    settings = json.loads((ROOT / '.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
    projects = sorted({r['project'] for r in corpus['records']})
    settings['projects'] = {name: {'path': str(state / 'notes' / name), 'mode': 'local'} for name in projects}
    manifest = {r['id']: r for r in corpus['records']}
    file_hashes = {}
    for item in corpus['records']:
        path = state / 'notes' / item['project'] / (item['id'] + '.md')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'---\ntitle: {item["title"]}\ntype: note\npermalink: {item["id"]}\n---\n\n# {item["title"]}\n\n{item["content"]}\n', encoding='utf-8')
        file_hashes[item['id']] = digest(path)
    bm.save(state / 'config/config.json', settings)
    receipt = {'format': 'hub-hbm-applicability-retrieval-v1', 'status': 'starting', 'corpusSha256': digest(REPORTS / 'corpus.json'), 'validationSha256': digest(REPORTS / 'validation.json'), 'results': []}
    client = None
    try:
        client = bm.Mcp(state, 'hybrid')
        receipt['initializeMs'] = client.initialize_ms
        bm.wait_ready(client, corpus, 'hybrid', receipt, WORK / 'readiness.json')
        for question in cases:
            start = time.perf_counter()
            hits = bm.results_from(client.call('search_notes', {'query': question['query'], 'project': question['project'], 'search_all_projects': False, 'search_type': 'vector', 'min_similarity': 0.0, 'page_size': 20, 'entity_types': ['entity'], 'output_format': 'json'}))
            candidates, excluded, seen = [], [], set()
            for hit in hits:
                key = bm.hit_identity(hit)
                record = manifest.get(key)
                if key in seen:
                    continue
                seen.add(key)
                if not record or record['project'] != question['project'] or record['status'] != 'confirmed':
                    excluded.append({'id': key, 'reason': 'scope_or_state'})
                    continue
                path = state / 'notes' / record['project'] / (key + '.md')
                if digest(path) != file_hashes[key]:
                    raise ValueError('Canonical note changed during retrieval')
                candidates.append({'id': key, 'project': record['project'], 'status': record['status'], 'title': record['title'], 'text': record['content']})
            receipt['results'].append({'id': question['id'], 'project': question['project'], 'candidates': candidates, 'excluded': excluded, 'elapsedMs': (time.perf_counter() - start) * 1000})
        receipt['usageAtEnd'] = client.usage()
        receipt['status'] = 'completed'
    except BaseException as error:
        receipt.update({'status': 'failed', 'errorType': type(error).__name__})
        raise
    finally:
        if client:
            client.close()
            receipt['residual'] = client.residual
            receipt['processExitCode'] = client.process.returncode
        save('retrieval.json', receipt)
    print(json.dumps({'status': receipt['status'], 'queries': len(receipt['results']), 'residual': receipt['residual']}))


def baseline():
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    _, cases = inputs()
    retrieval = read('retrieval.json')
    assert retrieval['status'] == 'completed'
    began = time.perf_counter()
    model = TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8', threads=2, cache_dir=str(ROOT / '.local/hbm-00/cache/models'))
    initialize_ms = (time.perf_counter() - began) * 1000
    rows = []
    for question, row in zip(cases, retrieval['results']):
        assert row['id'] == question['id']
        documents = [f'# {memory["title"]}\n\n{memory["text"]}' for memory in row['candidates']]
        began = time.perf_counter()
        scores = list(model.rerank(question['query'], documents, batch_size=8))
        ranked = sorted(zip(row['candidates'], scores), key=lambda pair: (-float(pair[1]), pair[0]['id']))
        ids = [memory['id'] for memory, score in ranked if 1 / (1 + math.exp(-max(-80, min(80, float(score))))) >= .5][:1]
        rows.append({'id': row['id'], 'ids': ids, 'rerankMs': (time.perf_counter() - began) * 1000})
    save('baseline.json', {'status': 'completed', 'policy': 'Prior fixed INT8 reranker >=0.5, top1 on same at-most-20 candidates; no refit', 'initializeMs': initialize_ms, 'results': rows})
    print('Unchanged control completed on 80 new questions')


def judge(executable):
    corpus, cases = inputs()
    retrieval = read('retrieval.json')
    assert retrieval['status'] == 'completed'
    by_case = {case['id']: case for case in cases}
    batch_size = read('policy-contract.json')['batchSize']
    rows, batches = [], []
    # Group by scope BEFORE constructing model input: another project is never
    # exposed simply because its question occurs in the same benchmark run.
    for project in sorted(corpus['projects']):
        scoped = sorted([row for row in retrieval['results'] if row['project'] == project], key=lambda row: row['id'])
        for offset in range(0, len(scoped), batch_size):
            batch = scoped[offset:offset + batch_size]
            memories = {memory['id']: memory for row in batch for memory in row['candidates']}
            assert all(memory['project'] == project and memory['status'] == 'confirmed' for memory in memories.values())
            tasks = [{'id': row['id'], 'project': project, 'question': by_case[row['id']]['query'], 'candidateIds': [m['id'] for m in row['candidates']]} for row in batch]
            payload = {'project': {'id': project, 'name': corpus['projects'][project]}, 'memories': list(memories.values()), 'tasks': tasks}
            prompt = POLICY + '\n待核验数据：\n' + json.dumps(payload, ensure_ascii=False)
            number = len(batches) + 1
            response, receipt = model_call(executable, prompt, SCHEMA, f'judge-{number:02}', timeout=120)
            checked = validate_decisions(response, tasks, list(memories.values()))
            save(f'judge-batch-{number:02}.json', {'project': project, 'caseIds': [t['id'] for t in tasks], 'inputPolicySha256': hashlib.sha256(POLICY.encode()).hexdigest(), 'receipt': receipt, 'results': checked})
            rows.extend(checked)
            batches.append(receipt)
            print(json.dumps({'batch': number, 'queries': len(checked), 'durationMs': receipt['durationMs'], 'invalid': sum(bool(row['invalid']) for row in checked)}), flush=True)
    assert len(rows) == 80 and {row['id'] for row in rows} == {case['id'] for case in cases}
    save('judgement.json', {'format': 'hub-hbm-applicability-judgement-v1', 'status': 'completed', 'policySourceSha256': read('policy-contract.json')['policySourceSha256'], 'validationSha256': digest(REPORTS / 'validation.json'), 'results': rows, 'batches': batches, 'tuningPassesOnValidation': 0})
    print('Frozen applicability judgement completed; no validation refit')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['retrieve', 'baseline', 'judge'])
    parser.add_argument('--codex')
    args = parser.parse_args()
    {'retrieve': retrieve, 'baseline': baseline, 'judge': lambda: judge(args.codex)}[args.phase]()
