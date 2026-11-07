"""Score the untouched frozen set; no thresholds, exclusions or label repair."""
import ast
import hashlib
import json
from pathlib import Path
import statistics

import psutil

from applicability_support import ROOT, WORK, REPORTS, CORPUS_ORIGINAL, ORIGINAL_HASH, digest, read, save

corpus = read('corpus.json')
validation = read('validation.json')
contract = read('validation-contract.json')
assert digest(REPORTS / 'validation.json') == contract['validationSha256']
assert digest(REPORTS / 'corpus.json') == contract['corpusSha256']
assert digest(CORPUS_ORIGINAL) == ORIGINAL_HASH
for relative, expected in read('execution-contract.json')['sources'].items():
    assert digest(ROOT / relative) == expected, relative
for source in Path(__file__).parent.glob('applicability*.py'):
    ast.parse(source.read_text(encoding='utf-8'))

cases = validation['cases']
manifest = {r['id']: r for r in corpus['records']}
retrieval = read('retrieval.json')
baseline = read('baseline.json')
judgement = read('judgement.json')
assert all(x['status'] == 'completed' for x in [retrieval, baseline, judgement])
assert judgement['tuningPassesOnValidation'] == 0
by_candidates = {r['id']: {m['id'] for m in r['candidates']} for r in retrieval['results']}


def grade(rows, selected_cases=cases):
    assert len(rows) == 80 and {row['id'] for row in rows} == {case['id'] for case in cases}
    by_id = {row['id']: row for row in rows}
    positives = [q for q in selected_cases if q['expected']]
    negatives = [q for q in selected_cases if not q['expected']]
    recovered = relevant = selected = violations = 0
    errors = []
    for question in selected_cases:
        ids = by_id[question['id']]['ids']
        hits = set(ids) & set(question['expected'])
        recovered += bool(hits)
        relevant += len(hits)
        selected += len(ids)
        for key in ids:
            record = manifest.get(key)
            violations += int(not record or record['status'] != 'confirmed' or record['project'] != question['project'] or key not in by_candidates[question['id']])
        if question['expected'] and not hits or not question['expected'] and ids:
            errors.append({'id': question['id'], 'project': question['project'], 'category': question['category'], 'query': question['query'], 'expected': question['expected'], 'selected': ids})
    negative_errors = [q['id'] for q in negatives if by_id[q['id']]['ids']]
    return {'positiveQuestions': len(positives), 'negativeQuestions': len(negatives), 'recovered': recovered, 'recallAt5': recovered / len(positives) if positives else None, 'selected': selected, 'relevantSelections': relevant, 'selectedContextPrecision': relevant / selected if selected else None, 'negativeFalseSelectionCases': len(negative_errors), 'negativeFalseSelectionIds': negative_errors, 'scopeStateViolations': violations, 'errors': errors}


candidate_recall = {}
for cap in [5, 20]:
    rows = [{'id': row['id'], 'ids': [memory['id'] for memory in row['candidates'][:cap]]} for row in retrieval['results']]
    candidate_recall[str(cap)] = grade(rows)['recallAt5']
control = grade(baseline['results'])
quality = grade(judgement['results'])
invalid = [row['id'] for row in judgement['results'] if row['invalid']]
passed = quality['recallAt5'] >= .9 and quality['selectedContextPrecision'] >= .8 and quality['negativeFalseSelectionCases'] == 0 and quality['scopeStateViolations'] == 0 and not invalid

batch_files = sorted(REPORTS.glob('judge-batch-*.json'))
frozen_policy = read('policy-contract.json')['policy']
for file in batch_files:
    batch = json.loads(file.read_text(encoding='utf-8'))
    request = WORK / batch['receipt']['name'] / 'input.txt'
    assert digest(request) == batch['receipt']['inputSha256']
    prompt = request.read_text(encoding='utf-8')
    assert prompt.startswith(frozen_policy)
    payload = json.loads(prompt.split('\n待核验数据：\n', 1)[1])
    assert set(payload) == {'project', 'memories', 'tasks'}
    assert all(set(t) == {'id', 'project', 'question', 'candidateIds'} for t in payload['tasks'])
    assert all(set(m) == {'id', 'project', 'status', 'title', 'text'} for m in payload['memories'])
    assert all(m['project'] == batch['project'] and m['status'] == 'confirmed' for m in payload['memories'])
    assert all(t['project'] == batch['project'] for t in payload['tasks'])

durations = [row['durationMs'] for row in judgement['batches']]
process_receipts = [json.loads(path.read_text(encoding='utf-8')) for path in WORK.glob('*/receipt.json')]
live = []
for receipt in process_receipts:
    assert receipt['status'] == 'completed' and receipt['exitCode'] == 0 and receipt['toolCalls'] == 0
    try:
        process = psutil.Process(receipt['pid'])
        if process.create_time() == receipt['createTime']:
            live.append({'pid': process.pid, 'name': process.name()})
    except psutil.NoSuchProcess:
        pass
mcp_process = json.loads((WORK / 'basic-memory/process.json').read_text(encoding='utf-8'))
assert mcp_process['status'] == 'exited' and not mcp_process['residual']
for receipt in mcp_process['owned']:
    try:
        process = psutil.Process(receipt['pid'])
        if process.create_time() == receipt['createTime']:
            live.append({'pid': process.pid, 'name': process.name()})
    except psutil.NoSuchProcess:
        pass
assert not live

old = json.loads((ROOT / '.local/hbm-20261018/changes.json').read_text(encoding='utf-8'))
production = [r for r in old['files'] if r['path'].startswith(('src/', 'src-tauri/')) and r['path'] != 'src-tauri/src/agent_work/memory_selection_tests.rs']
assert all(digest(ROOT / entry['path']) == entry['sha256'] for entry in production)

summary = {
    'format': 'hub-hbm-applicability-summary-v1',
    'scope': 'One frozen synthetic atomic-question validation, no original-question refit',
    'qualityGatePassedOnThisSet': passed, 'backendDecision': 'undecided', 'hbm00Qualified': False,
    'validationIdentity': contract, 'policyIdentity': digest(Path(__file__).with_name('applicability_policy.py')),
    'candidateRecallAfterHostFiltering': candidate_recall,
    'unchangedControl': control, 'applicability': quality,
    'invalidModelDecisionCount': len(invalid), 'invalidModelDecisionIds': invalid,
    'byProject': {key: grade(judgement['results'], [q for q in cases if q['project'] == key]) for key in corpus['projects']},
    'byCategory': {key: grade(judgement['results'], [q for q in cases if q['category'] == key]) for key in sorted({q['category'] for q in cases})},
    'cost': {'generatorModelCalls': 1, 'judgeModelCalls': len(durations), 'explicitRetries': 0, 'judgeTotalMs': sum(durations), 'judgeBatchMedianMs': statistics.median(durations), 'judgeBatchP95Ms': statistics.quantiles(durations, n=100, method='inclusive')[94], 'judgeInputTokens': sum(b['usage'].get('input_tokens', 0) for b in judgement['batches']), 'judgeOutputTokens': sum(b['usage'].get('output_tokens', 0) for b in judgement['batches']), 'timingLimit': 'Up to 8 same-project queries in one model call. Batch throughput cannot stand in for single interactive query latency or 1-second service qualification.'},
    'verification': {'controlsTestsPassed': 7, 'executionSourceHashesMatched': True, 'corpusAndValidationHashesMatched': True, 'oldCorpusUnchanged': True, 'productionSourceUnchanged': True, 'judgeInputContainsGoldFields': False, 'crossProjectInputExposure': False, 'policyOrLabelChangesAfterFreeze': 0, 'ownedProcessesStillAlive': live},
    'limits': ['Synthetic data, same model family generated questions and judged candidates; correlated bias possible', 'Single run, 40 positive and 40 negative cases, not proof of universal zero false positives', 'Atomic questions and at most one supporting memory; multi-memory or multi-step tasks unverified', 'Existing gpt-6.1-sol test adapter only; DeepSeek/model substitution not validated in this batch', '20-task generation effects, representative personal libraries, installed runtime/latency, 24-hour soak and full lifecycle remain open'],
    'setupDiagnostic': 'Initial log redirection failed because the isolated directory did not yet exist; no model call started. Directory created before the one actual generator invocation. No evaluation question rerun.'
}
save('summary.json', summary)
print(json.dumps({'qualityGatePassedOnThisSet': passed, 'applicability': {k:v for k,v in quality.items() if k != 'errors'}, 'baseline': {k:v for k,v in control.items() if k != 'errors'}, 'candidateRecall': candidate_recall, 'modelCalls': len(durations), 'batchMedianMs': statistics.median(durations), 'backendDecision': 'undecided'}, ensure_ascii=False))
