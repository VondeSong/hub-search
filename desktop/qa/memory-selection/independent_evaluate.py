"""One sequential measured retrieval-to-selection run, no question-dependent tuning."""
import argparse
from datetime import datetime, timezone
import json
import time
from pathlib import Path

import run as bm
from applicability_policy import POLICY, SCHEMA, validate_decisions
from independent_support import ROOT, WORK, REPORTS, CODEX_MODEL, codex_call, digest, read, save


def source_files():
    base = Path(__file__).parent
    return {name: digest(base / name) for name in ['independent_evaluate.py', 'independent_support.py',
                                                  'independent_fixture.py', 'applicability_policy.py', 'run.py']}


def production_files():
    files = []
    for folder in ['src', 'src-tauri/src', 'src-tauri/resources']:
        root = ROOT / folder
        if root.exists():
            files.extend(p for p in root.rglob('*') if p.is_file())
    files += [ROOT / name for name in ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml',
                                      'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'] if (ROOT / name).is_file()]
    return {str(path.relative_to(ROOT)).replace('\\', '/'): digest(path) for path in sorted(files)}


def freeze_execution():
    contract = read('validation-contract.json')
    for name, expected in contract['sources'].items():
        assert digest(Path(__file__).with_name(name)) == expected
    save('execution-contract.json', {'format': 'hub-hbm-realistic-execution-v1',
                                      'sources': source_files(), 'production': production_files(),
                                      'validationSha256': digest(REPORTS / 'validation.json'),
                                      'corpusSha256': digest(REPORTS / 'corpus.json'),
                                      'model': CODEX_MODEL, 'runLimit': 1, 'explicitRetries': 0,
                                      'remoteCI': 'Not applicable: no Git root or public candidate; isolated experiment only'})
    print('Execution source and production source identities frozen')


def run():
    frozen = read('execution-contract.json')
    assert source_files() == frozen['sources']
    assert digest(REPORTS / 'validation.json') == frozen['validationSha256']
    assert digest(REPORTS / 'corpus.json') == frozen['corpusSha256']
    corpus, cases = read('corpus.json'), read('validation.json')['cases']
    state = WORK / 'basic-memory'
    state.mkdir(parents=True, exist_ok=False)
    config = json.loads((ROOT / '.local/hbm-00/hybrid-v2/config/config.json').read_text(encoding='utf-8'))
    config['projects'] = {name: {'path': str(state / 'notes' / name), 'mode': 'local'}
                          for name in sorted({r['project'] for r in corpus['records']})}
    manifest, file_hashes = {r['id']: r for r in corpus['records']}, {}
    for r in corpus['records']:
        path = state / 'notes' / r['project'] / (r['id'] + '.md')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'---\ntitle: {r["title"]}\ntype: note\npermalink: {r["id"]}\n---\n\n# {r["title"]}\n\n{r["content"]}\n', encoding='utf-8')
        file_hashes[r['id']] = digest(path)
    bm.save(state / 'config/config.json', config)
    receipt = {'format': 'hub-hbm-realistic-e2e-v1', 'status': 'starting', 'model': CODEX_MODEL,
               'startedAt': datetime.now(timezone.utc).isoformat(), 'results': [],
               'sourceSha256': frozen['sources'], 'fileHashes': file_hashes,
               'explicitRetries': 0, 'tuningPasses': 0}
    client = None
    began = time.perf_counter()
    try:
        client = bm.Mcp(state, 'hybrid')
        receipt['initializeMs'] = client.initialize_ms
        ready_began = time.perf_counter()
        bm.wait_ready(client, corpus, 'hybrid', receipt, WORK / 'readiness.json')
        receipt['indexReadyMs'] = (time.perf_counter() - ready_began) * 1000
        for index, question in enumerate(cases):
            start = time.perf_counter()
            started_at = datetime.now(timezone.utc).isoformat()
            hits = bm.results_from(client.call('search_notes', {
                'query': question['query'], 'project': question['project'], 'search_all_projects': False,
                'search_type': 'vector', 'min_similarity': 0.0, 'page_size': 20,
                'entity_types': ['entity'], 'output_format': 'json'}))
            candidates, excluded, seen = [], [], set()
            for hit in hits:
                ident = bm.hit_identity(hit)
                if ident in seen:
                    continue
                seen.add(ident)
                r = manifest.get(ident)
                if not r or r['project'] != question['project'] or r['status'] != 'confirmed':
                    excluded.append({'id': ident, 'reason': 'scope_or_state'})
                    continue
                path = state / 'notes' / r['project'] / (ident + '.md')
                if digest(path) != file_hashes[ident]:
                    raise ValueError('Canonical memory file changed')
                candidates.append({'id': ident, 'project': r['project'], 'status': r['status'],
                                   'title': r['title'], 'text': r['content']})
            retrieval_ms = (time.perf_counter() - start) * 1000
            assembly_began = time.perf_counter()
            task = {'id': question['id'], 'project': question['project'], 'question': question['query'],
                    'candidateIds': [m['id'] for m in candidates]}
            payload = {'project': {'id': question['project'], 'name': corpus['projects'][question['project']]},
                       'memories': candidates, 'tasks': [task]}
            prompt = POLICY + '\n待核验数据：\n' + json.dumps(payload, ensure_ascii=False)
            assembly_ms = (time.perf_counter() - assembly_began) * 1000
            # Never serialize the case's category, expected IDs or gold quote into input.
            response, model_receipt = codex_call(prompt, SCHEMA, f'query-{index+1:03}', timeout=90)
            verify_began = time.perf_counter()
            checked = validate_decisions(response, [task], candidates)[0]
            for memory in candidates:
                path = state / 'notes' / memory['project'] / (memory['id'] + '.md')
                if digest(path) != file_hashes[memory['id']]:
                    raise ValueError('Memory changed before selection')
            verify_ms = (time.perf_counter() - verify_began) * 1000
            row = {'id': question['id'], 'project': question['project'], 'startedAt': started_at,
                   'candidates': candidates, 'excluded': excluded, 'rawHitCount': len(hits),
                   'retrievalMs': retrieval_ms, 'assemblyMs': assembly_ms, 'modelMs': model_receipt['durationMs'],
                   'verificationMs': verify_ms, 'endToEndMs': (time.perf_counter() - start) * 1000,
                   'checked': checked, 'modelReceipt': model_receipt}
            save(f'query-{index+1:03}.json', row)
            receipt['results'].append(row)
            print(json.dumps({'completed': index+1, 'total': len(cases), 'e2eMs': round(row['endToEndMs'], 2)}), flush=True)
        receipt['status'] = 'completed'
        receipt['usageAtEnd'] = client.usage()
    except BaseException as error:
        receipt.update({'status': 'failed', 'errorType': type(error).__name__})
        raise
    finally:
        if client:
            client.close()
            receipt['residual'] = client.residual
            receipt['processExitCode'] = client.process.returncode
        receipt['totalMs'] = (time.perf_counter() - began) * 1000
        save('evaluation.json', receipt)
    print(json.dumps({'status': receipt['status'], 'questions': len(receipt['results']),
                      'residual': receipt.get('residual')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['freeze', 'run'])
    args = parser.parse_args()
    {'freeze': freeze_execution, 'run': run}[args.phase]()
