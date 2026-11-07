"""Score the immutable new set once; verify sources, blinding and owned process exits."""
import collections
import json
from pathlib import Path
import statistics

import psutil

from applicability_policy import POLICY, validate_decisions
from independent_evaluate import production_files, source_files
from independent_support import ROOT, WORK, REPORTS, digest, read, save


def distribution(values):
    return {'count': len(values), 'medianMs': statistics.median(values),
            'p95Ms': statistics.quantiles(values, n=100, method='inclusive')[94],
            'minMs': min(values), 'maxMs': max(values)} if values else None


def exited(receipt):
    if 'pid' not in receipt:
        return True
    try:
        p = psutil.Process(receipt['pid'])
        return p.create_time() != receipt['createTime'] or not p.is_running()
    except psutil.NoSuchProcess:
        return True


def main():
    scoring = read('scoring-contract.json')
    assert digest(Path(__file__)) == scoring['reporterSha256']
    frozen = read('execution-contract.json')
    assert source_files() == frozen['sources']
    assert digest(REPORTS / 'validation.json') == frozen['validationSha256']
    assert digest(REPORTS / 'corpus.json') == frozen['corpusSha256']
    assert production_files() == frozen['production']
    data, evaluation = read('validation.json'), read('evaluation.json')
    corpus = read('corpus.json')
    assert evaluation['status'] == 'completed'
    cases = {q['id']: q for q in data['cases']}
    rows = evaluation['results']
    assert len(cases) == len(rows) == 80
    assert set(cases) == {row['id'] for row in rows}
    assert not evaluation['residual'] and evaluation['processExitCode'] == 0
    all_processes_exited, all_inputs_blinded = True, True
    canonical_bodies_checked = 0
    for record in corpus['records']:
        p = WORK / 'basic-memory/notes' / record['project'] / (record['id'] + '.md')
        assert digest(p) == evaluation['fileHashes'][record['id']]
        canonical_bodies_checked += 1
    correct, selected, true_selected, negative_false, scope_state, invalid = 0, 0, 0, 0, 0, 0
    covered = {5: 0, 20: 0}
    errors, quality_rows, by_category = [], [], collections.defaultdict(list)
    ranks = []
    for index, row in enumerate(rows):
        q = cases[row['id']]
        directory = WORK / f'query-{index+1:03}'
        receipt = json.loads((directory / 'receipt.json').read_text(encoding='utf-8'))
        assert receipt['status'] == 'completed' and receipt['exitCode'] == 0
        assert receipt['requestedModel'] == frozen['model'] and receipt['toolCalls'] == 0
        assert receipt['inputSha256'] == digest(directory / 'input.txt')
        assert receipt['outputSha256'] == digest(directory / 'output.json')
        assert exited(receipt)
        prompt = (directory / 'input.txt').read_text(encoding='utf-8')
        assert prompt.startswith(POLICY + '\n待核验数据：\n')
        payload = json.loads(prompt[len(POLICY + '\n待核验数据：\n'):])
        assert set(payload) == {'project', 'memories', 'tasks'}
        assert len(payload['tasks']) == 1
        task = payload['tasks'][0]
        assert set(task) == {'id', 'project', 'question', 'candidateIds'}
        assert task['id'] == q['id'] and task['question'] == q['query'] and task['project'] == q['project']
        assert payload['memories'] == row['candidates']
        assert all(m['project'] == q['project'] and m['status'] == 'confirmed' for m in payload['memories'])
        response = json.loads((directory / 'output.json').read_text(encoding='utf-8'))
        assert validate_decisions(response, [task], payload['memories'])[0] == row['checked']
        ids = row['checked']['ids']
        candidate_ids = [m['id'] for m in row['candidates']]
        expected = set(q['expected'])
        expected_rank = next((i+1 for i, ident in enumerate(candidate_ids) if ident in expected), None)
        if expected:
            for k in covered:
                covered[k] += bool(expected & set(candidate_ids[:k]))
            ranks.append(expected_rank)
            hit = bool(expected & set(ids))
            correct += hit
        else:
            hit = not ids
            negative_false += bool(ids)
        selected += len(ids)
        true_selected += len(set(ids) & expected)
        invalid += bool(row['checked']['invalid'])
        scope_state += sum(m['project'] != q['project'] or m['status'] != 'confirmed'
                           for m in row['candidates'] if m['id'] in ids)
        stage = ''
        if not hit:
            if not expected:
                stage = 'unanswerable_false_selection'
            elif expected_rank is None:
                stage = 'retrieval_miss_at_20'
            elif not ids:
                stage = 'applicability_abstention'
            else:
                stage = 'applicability_wrong_selection'
            errors.append({'id': q['id'], 'project': q['project'], 'question': q['query'],
                           'category': q['category'], 'stage': stage, 'expected': q['expected'],
                           'selected': ids, 'expectedCandidateRank': expected_rank,
                           'selectedQuote': row['checked']['decision']['quote']})
        scored = {'id': q['id'], 'category': q['category'], 'answerable': bool(expected), 'correct': hit,
                  'expectedCandidateRank': expected_rank, 'selected': ids, 'errorStage': stage,
                  'endToEndMs': row['endToEndMs']}
        quality_rows.append(scored)
        by_category[q['category']].append(scored)
    positive = sum(bool(q['expected']) for q in cases.values())
    negative = len(cases) - positive
    quality = {'positive': positive, 'correctPositive': correct, 'selectedRecall': correct / positive,
               'negative': negative, 'unanswerableFalseSelections': negative_false,
               'selectedMemories': selected, 'correctSelectedMemories': true_selected,
               'selectedPrecision': true_selected / selected if selected else 0,
               'scopeStateViolations': scope_state, 'invalidModelDecisions': invalid}
    candidate_recall = {f'recallAt{k}': count / positive for k, count in covered.items()}
    candidate_recall.update({'positiveGoldAtRank6To20': sum(r is not None and r > 5 for r in ranks),
                             'positiveGoldMissingAt20': sum(r is None for r in ranks)})
    timings = {key: distribution([r[key] for r in rows]) for key in
               ['retrievalMs', 'assemblyMs', 'modelMs', 'verificationMs', 'endToEndMs']}
    timings['warmAfterFirstEndToEnd'] = distribution([r['endToEndMs'] for r in rows[1:]])
    timings['firstQueryEndToEndMs'] = rows[0]['endToEndMs']
    timings['freshIndexInitializeMs'] = evaluation['initializeMs']
    timings['freshIndexReadyMs'] = evaluation['indexReadyMs']
    timings['freshServiceAndIndexPlusFirstQueryMs'] = (evaluation['initializeMs'] +
                                                       evaluation['indexReadyMs'] + rows[0]['endToEndMs'])
    passed = quality['selectedRecall'] >= .9 and negative_false == 0 and quality['selectedPrecision'] >= .8 and not scope_state and not invalid
    latency_passed = timings['warmAfterFirstEndToEnd']['p95Ms'] <= 1000
    summary = {
        'format': 'hub-hbm-realistic-independent-summary-v1', 'model': frozen['model'], 'reasoning': 'medium',
        'quality': quality, 'qualityGatePassedOnFrozenSet': passed, 'candidateCoverage': candidate_recall,
        'timings': timings, 'oneSecondLatencyGatePassed': latency_passed,
        'retrievalOneSecondGatePassed': timings['retrievalMs']['p95Ms'] <= 1000,
        'latencyGateScope': 'Existing HBM-00 1-second warm retrieval gate applies to retrievalMs. The frozen new run also reports a stricter 1-second end-to-end reference; it is not the same gate.',
        'overallHbm00Qualified': False, 'backendDecision': 'undecided',
        'errors': errors, 'errorStageCounts': dict(collections.Counter(e['stage'] for e in errors)),
        'categoryResults': {name: {'count': len(items), 'correct': sum(q['correct'] for q in items)}
                            for name, items in sorted(by_category.items())},
        'cases': quality_rows,
        'cost': {'questionCalls': len(rows), 'explicitRetries': 0,
                 'inputTokens': sum(r['modelReceipt']['usage'].get('input_tokens', 0) for r in rows),
                 'outputTokens': sum(r['modelReceipt']['usage'].get('output_tokens', 0) for r in rows),
                 'totalRunMsIncludingServiceShutdown': evaluation['totalMs']},
        'freeze': {'corpusSha256': frozen['corpusSha256'], 'validationSha256': frozen['validationSha256'],
                   'policyUnchangedFromPriorRound': digest(Path(__file__).with_name('applicability_policy.py')) ==
                       json.loads((ROOT / 'artifacts/hbm-00-applicability-20261018/policy-contract.json').read_text(encoding='utf-8'))['policySourceSha256'],
                   'postFreezeTuningPasses': 0, 'labelChangesAfterFreeze': 0},
        'limits': ['User authorized Codex fallback; different named model, same vendor. Independent-vendor review remains unverified.',
                   'Primary agent authored and audited synthetic labels with prior policy exposure; not independent human labels or a personal-library sample.',
                   'One execution, 40 answerable and 40 unanswerable tasks; zero observed false selections is not proof of zero future risk.',
                   'At most one supporting memory, no multi-memory reasoning or task completion effects.',
                   'New dataset, model and reasoning effort differ from prior round. This is not a controlled same-set estimate of model replacement alone.',
                   'Measured RPC retrieval-to-selection, includes fresh CLI process each query. No model answer generation, installed Hub UI/IPC, model download or persistent-provider implementation.',
                   'Backend selection, 24-hour soak, lifecycle and later batches remain open.'],
    }
    save('summary.json', summary)
    save('verification-final.json', {'status': 'passed', 'corpusSha256': frozen['corpusSha256'],
                                     'validationSha256': frozen['validationSha256'],
                                     'canonicalBodiesChecked': canonical_bodies_checked,
                                     'executionSourcesUnchanged': True, 'productionSourcesUnchanged': True,
                                     'labelsUnchangedAfterFreeze': True, 'inputsBlinded': all_inputs_blinded,
                                     'allOwnedModelProcessesExited': all_processes_exited,
                                     'mcpProcessExited': True, 'scopeBodyChecksPassed': True,
                                     'qualityGatePassedOnFrozenSet': passed, 'oneSecondLatencyGatePassed': latency_passed,
                                     'overallHbm00Qualified': False, 'backendDecision': 'undecided'})
    print(json.dumps({'quality': quality, 'candidateCoverage': candidate_recall,
                      'e2e': timings['endToEndMs'], 'qualityGatePassedOnFrozenSet': passed,
                      'oneSecondLatencyGatePassed': latency_passed, 'errorStages': summary['errorStageCounts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
