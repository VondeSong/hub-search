"""Validate and summarize diagnosis receipts, preserving all earlier evidence."""
import ast
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

import psutil

from diagnose import ROOT, WORK, REPORTS, EXPECTED_HASH, corpus, measure, save

data = corpus()
identities = {q['id'] for q in data['queries']}


def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))


def validate(rows):
    assert len(rows) == 60 and {row['id'] for row in rows} == identities


native = {}
for label, run_id in [('keyword-or', '06d4c771-3071-4f82-ba1b-9f5247bb5779'), ('keyword-and', '1e899886-2f84-43cc-9a63-4a2903c9ff29'), ('normalized-or', '91fc8e98-53c1-40f3-af57-c2fa0709b679')]:
    receipt = read(f'native-{label}.json')
    assert receipt['corpusSha256'] == EXPECTED_HASH
    validate(receipt['results'])
    native[label] = measure(data, receipt['results'])
    test_path = ROOT / '.local/rust-test-runs' / run_id / 'receipt.json'
    test = json.loads(test_path.read_text(encoding='utf-8'))
    assert test['status'] == 'passed' and test['collected'] == 1 and test['byteIdentical']
    (REPORTS / f'native-{label}.test-receipt.json').write_bytes(test_path.read_bytes())

mcp = read('mcp.json')
assert mcp['status'] == 'completed' and not mcp['residual'] and mcp['processExitCode'] == 0
for value in mcp['variants'].values():
    validate(value['results'])
rerank = read('rerank.json')
rerank5 = read('rerank5.json')
for value in [rerank, rerank5]:
    assert value['status'] == 'completed'
    validate(value['results'])

# An oracle bound diagnoses score overlap; it is not a chosen production
# threshold, a fresh validation, or a replacement for the frozen policy.
negative_max = max(row['scores'][0]['probability'] for q, row in zip(data['queries'], rerank['rankedScores']) if not q['expected'])
safe_gold = 0
negative_max_ids = []
for question, row in zip(data['queries'], rerank['rankedScores']):
    if question['expected']:
        safe_gold += any(hit['id'] in question['expected'] and hit['probability'] > negative_max for hit in row['scores'][:5])
    elif row['scores'][0]['probability'] == negative_max:
        negative_max_ids.append(question['id'])

old_changes = json.loads((ROOT / '.local/hbm-20261018/changes.json').read_text(encoding='utf-8'))
production = [entry for entry in old_changes['files'] if entry['path'].startswith(('src/', 'src-tauri/')) and entry['path'] != 'src-tauri/src/agent_work/memory_selection_tests.rs']
for entry in production:
    assert hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest() == entry['sha256'], entry['path']

sources = sorted(Path(__file__).parent.glob('*.py'))
for source in sources:
    ast.parse(source.read_text(encoding='utf-8'))
source_hashes = {str(p.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
versions = sorted(f'{dist.metadata["Name"]}=={dist.version}' for dist in importlib.metadata.distributions())
(REPORTS / 'requirements.freeze.txt').write_text('\n'.join(versions) + '\n', encoding='utf-8')

process = json.loads((WORK / 'basic-memory/process.json').read_text(encoding='utf-8'))
alive = []
for member in process['owned']:
    try:
        p = psutil.Process(member['pid'])
        if p.create_time() == member['createTime']:
            alive.append({'pid': p.pid, 'name': p.name()})
    except psutil.NoSuchProcess:
        pass
assert not alive

events = [json.loads(line) for line in (WORK / 'query-normalizer/events.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
usage = next(row['usage'] for row in events if row['type'] == 'turn.completed')
assert not any(row.get('item', {}).get('type') in ['command_execution', 'mcp_tool_call'] for row in events)

inodes = set()
logical = distinct = files = 0
for path in (ROOT / '.local/hbm-00').rglob('*'):
    if path.is_file():
        stat = path.stat()
        logical += stat.st_size
        files += 1
        key = (stat.st_dev, stat.st_ino)
        if key not in inodes:
            inodes.add(key)
            distinct += stat.st_size
assert logical < 8 * 1024**3
assert psutil.disk_usage(str(WORK)).free > 10 * 1024**3

summary = {
    'format': 'hub-hbm-retrieval-diagnosis-summary-v1', 'createdAt': time.time(), 'corpusSha256': EXPECTED_HASH,
    'scope': 'HBM-00 diagnosis only, frozen project-plan pilot corpus, no representative personal-library claim',
    'backendDecision': 'undecided', 'hbm00Qualified': False,
    'nativeActualEntry': native,
    'basicMemoryActualMcp': {key: value['metrics'] for key, value in mcp['variants'].items()},
    'lexicalPrototype': {key: value['metrics'] for key, value in read('lexical.json')['variants'].items()},
    'directEmbeddingDiagnostics': {label: {key: value['metrics'] for key, value in read(f'vectors-{label}.json')['variants'].items() if 'rank-only' in key or key.endswith('0.65')} for label in ['bge', 'minilm', 'bge-normalized']},
    'directEmbeddingTimingLimit': 'Rows contain batch mean, not a measured per-query P95; do not use for performance qualification',
    'rerank20': {key: rerank[key] for key in ['candidateRecallAt20', 'rawRerankAt5', 'selectedPolicy', 'calibration', 'validation', 'allMetrics', 'rerankTiming', 'rssMiB']},
    'rerank5': {key: rerank5[key] for key in ['policy', 'allMetrics', 'rerankTiming', 'rssMiB']},
    'scoreOverlapDiagnosticOnly': {'largestNegativeTopScore': negative_max, 'negativeQueryIds': negative_max_ids, 'maxRecallAt5WithAnySingleScoreThresholdAndZeroNegativesOnObservedSet': safe_gold / 40, 'limit': 'Uses all observed labels solely to show separability ceiling. Not a fitted policy or acceptance score.'},
    'findings': [
        {'id': 'QUERY-BOOLEAN', 'status': 'confirmed on frozen pilot', 'owner': 'Query adapter', 'evidence': 'Same keyword set through real Hub index: AND 42.5% vs OR 90%; precision and negatives worsen. No production parser change.'},
        {'id': 'CHINESE-TOKENS', 'status': 'confirmed on frozen pilot', 'owner': 'Basic Memory local FTS tokenizer and adapter', 'evidence': 'Unicode61 vocabulary contains uninterrupted Chinese phrases; matched SQLite controls show segmentation effects. Standalone prototype is not the complete Basic Memory search pipeline.'},
        {'id': 'SCORE-ADMISSION', 'status': 'confirmed on frozen pilot', 'owner': 'Candidate admission', 'evidence': 'BGE top-5 95% before .65 vs 47.5% after; actual BM vector entry also 95%. Lower score raises false admissions; global score overlap remains after reranking.'},
        {'id': 'EMBEDDING-REPLACEMENT', 'status': 'not supported as primary fix by these two models', 'owner': 'Embedding evaluation', 'evidence': 'BGE 95% raw top-5 vs multilingual MiniLM 92.5%; instruction 95%. No broader claim about all embedding models.'},
        {'id': 'QUERY-REWRITE', 'status': 'tested, not adopted', 'owner': 'Query planning', 'evidence': 'One query-only model rewrite does not improve actual BM hybrid (60% to 55%); adds a 28.8-second planning call.'},
        {'id': 'CALIBRATION', 'status': 'stress-test failure retained', 'owner': 'Evaluation design and admission calibration', 'evidence': 'Lexical-only calibration is much easier than paraphrases and isolation guards. Calibration success cannot stand in for validation.'},
    ],
    'queryPlanningCost': {'calls': 1, 'explicitRetries': 0, 'durationMs': read('queries-normalized.json')['durationMs'], 'usage': usage, 'toolsExecuted': False, 'runtimeWarnings': ['Experimental skip_host_skill_discovery feature warning', 'Code Mode unavailable with host disabled; no tool use required'], 'limit': 'This is query-planning evaluation, not the 20-task memory-effect gate'},
    'verification': {'queryCoveragePerVariant': 60, 'nativeTestIdentityCount': 1, 'nativeInputVariants': 3, 'productionFilesMatchingPreviousHbm01aSnapshot': len(production), 'productionSourceUnchanged': True, 'pythonAstFilesChecked': len(sources), 'sourceSha256': source_hashes, 'mcpOwnedResidual': alive},
    'resources': {'managedFiles': files, 'managedLogicalGiB': logical / 1024**3, 'distinctFileGiB': distinct / 1024**3, 'diskLimitGiB': 8, 'measurement': 'File lengths, inode hardlink dedup; excludes shared Rust build target and physical allocation effects', 'dependencies': len(versions), 'jieba': importlib.metadata.version('jieba'), 'outsideManagedRoot': 'Jieba default dictionary cache was written once to OS temp before its experimental cache directory was configured; retained, no shared cache deletion'},
    'unverified': ['Representative personal-library and independent unseen queries', '20-task paired generation effects', '24-hour soak and full lifecycle', 'Production memory integration and installed service end-to-end timing'],
    'nextWithinHbm00': 'Evaluate explicit query applicability / answerability and representative calibration with fresh frozen verification; retain raw candidate vs admitted context distinction. No backend choice or later batches.'
}
save('summary.json', summary)
print(json.dumps({'summary': str(REPORTS / 'summary.json'), 'productionSourceUnchanged': True, 'maxRecallSingleGlobalThresholdZeroNegatives': safe_gold / 40, 'logicalGiB': logical / 1024**3, 'distinctFileGiB': distinct / 1024**3, 'mcpResidual': alive, 'backendDecision': 'undecided'}, ensure_ascii=False))
