"""Calibration uses lexical positives/6 negatives only; verification never tunes."""
import itertools
import json

from diagnose import REPORTS, EXPECTED_HASH, corpus, save

data = corpus()
calibration_ids = {q['id'] for q in data['queries'] if q['expected'] and q['category'] != 'paraphrase'} | {f'q{i:02}' for i in range(41, 47)}
validation_ids = {q['id'] for q in data['queries']} - calibration_ids
grid = list(itertools.product([.35, .4, .45, .5, .55, .6, .65, .7, .75, .8], [0, .01, .025, .05, .075, .1], [1, 2, 3, 5], [0, .025, .05, .1]))
save('admission-contract.json', {'format': 'hub-hbm-admission-contract-v1', 'corpusSha256': EXPECTED_HASH, 'calibrationIds': sorted(calibration_ids), 'validationIds': sorted(validation_ids), 'parameters': ['minimum cosine', 'top1-top2 margin', 'maximum documents', 'maximum distance from top1'], 'grid': grid, 'selection': 'Calibration precision >=80%, zero no-answer admissions; maximize positive recall, then precision, then simplicity. Validation and guards never tune policy.', 'acceptanceGatesUnchanged': True, 'limit': 'Previously observed pilot corpus, not a blind external benchmark; no production injection.'})


def select_rows(receipt, policy):
    threshold, margin, top_k, distance = policy
    scores = receipt['allScores']['plain']
    records = {r['id']: r for r in data['records']}
    rows = []
    for question, values in zip(data['queries'], scores):
        ranked = sorted(zip(receipt['recordOrder'], values), key=lambda row: (-row[1], row[0]))
        raw = [(key, score) for key, score in ranked if records[key]['project'] == question['project']][:20]
        eligible = [(key, score) for key, score in raw if records[key]['status'] == 'confirmed']
        qualified = eligible and eligible[0][1] >= threshold and (len(eligible) == 1 or eligible[0][1] - eligible[1][1] >= margin)
        ids = [key for key, score in eligible if score >= threshold and eligible[0][1] - score <= distance][:top_k] if qualified else []
        rows.append({'id': question['id'], 'ids': ids})
    return rows


def quality(rows, identities):
    by_id = {row['id']: row['ids'] for row in rows}
    positives = [q for q in data['queries'] if q['id'] in identities and q['expected']]
    questions = [q for q in data['queries'] if q['id'] in identities]
    hits = sum(bool(set(q['expected']) & set(by_id[q['id']])) for q in positives)
    selected = sum(len(by_id[q['id']]) for q in questions)
    relevant = sum(len(set(q['expected']) & set(by_id[q['id']])) for q in questions)
    negative = [q['id'] for q in questions if not q['expected'] and by_id[q['id']]]
    return {'positiveQueries': len(positives), 'recallAt5': hits / len(positives) if positives else None, 'selectedContextPrecision': relevant / selected if selected else 0, 'negativeCases': negative, 'selected': selected}


out = {}
for name in ['bge', 'minilm', 'bge-normalized']:
    source = json.loads((REPORTS / f'vectors-{name}.json').read_text(encoding='utf-8'))
    qualified = []
    for policy in grid:
        rows = select_rows(source, policy)
        q = quality(rows, calibration_ids)
        if q['selectedContextPrecision'] >= .8 and not q['negativeCases']:
            qualified.append((q['recallAt5'], q['selectedContextPrecision'], -policy[2], policy, rows, q))
    best = max(qualified, key=lambda row: row[:3]) if qualified else None
    out[name] = {'policy': best[3] if best else None, 'calibration': best[5] if best else None, 'validation': quality(best[4], validation_ids) if best else None, 'all': quality(best[4], {q['id'] for q in data['queries']}) if best else None, 'results': best[4] if best else None}
save('admission.json', {'format': 'hub-hbm-admission-result-v1', 'candidates': out})
print(json.dumps({key: {k: v for k, v in value.items() if k != 'results'} for key, value in out.items()}, ensure_ascii=False))
