"""Content/label review before first retrieval; does not call retrieval or a model."""
from collections import Counter
from datetime import datetime, timezone
from accounting_support import read,save,REPORTS,digest

draft=read('validation-draft.json'); corpus=read('corpus.json')
records={r['id']:r for r in corpus['records']}; cases=draft['cases']
assert len(cases)==140 and len(records)==266
for q in cases:
    if q['expected']:
        r=records[q['expected'][0]]
        assert r['status']=='confirmed' and r['project']==q['project'] and q['goldSupport'] in r['content']
assert not (REPORTS/'execution-start.json').exists()
save('validation-audit.json',{'status':'reviewed_before_retrieval','at':datetime.now(timezone.utc).isoformat(),
 'authorAndLabelReviewer':'Primary Codex agent, same GPT-6.1 Sol family as judging model; no independent annotation.',
 'review':'Read all 10 source excerpts and all 140 authored questions. Positives specify source statements or exact fictional versions; negatives ask missing attributes/events, current facts from inactive entries, other project facts, or instruction execution. Old and new bodies were not searched to choose favorable retrieval ranks.',
 'counts':dict(Counter(q['category'] for q in cases)),
 'realNotes':10,'realPositive':20,'syntheticPositive':20,'negative':100,
 'rankHardness':'Near subject/version distractors and label-blind candidate rotation. Actual retrieval rank hardness is measured after the sole run, never selected by querying the holdout.',
 'sourceLimit':'Only explicit text in the snapshot supports these questions. Images, linked pages and actual vault-state events are not inferred. Historical MOC is a historical proposal, not current authority.',
 'binaryGold':'One supporting canonical memory per positive; no supported memory for negatives. Exact quote and host scope/state checks remain required.',
 'fixtureSha256':draft['sourceFixtureSha256'],'retrievalCalls':0,'judgingCalls':0,'changesAfterObservedResults':0})
