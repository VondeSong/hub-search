"""Human-authored post-hoc diagnosis; keeps all frozen scores and labels intact."""
import json
from pathlib import Path
from qualification_contract import *
from parity_index import fuse, unique

evaluation=read('evaluation.json');cases={q['id']:q for q in read('validation.json')['cases']}
rows={r['id']:r for r in evaluation['rows']}
records={r['id']:r for r in read('corpus.json')['records']}
passages=json.loads((WORK/'new-quality-index/passages.json').read_text(encoding='utf-8'))['passages']
q=cases['q-780618df2eb5db5c'];found=rows[q['id']]['retrieval'];mid=q['expected'][0]
parents=lambda ids:unique(passages[pid]['memoryId'] for pid in ids)
vectors=parents(found['vectorPassages']);lexical=parents(found['lexicalPassages']);full=fuse(vectors,lexical)
rank=lambda ids:ids.index(mid)+1 if mid in ids else None
retrieval={'vectorParentRankWithinReturned50Passages':rank(vectors),
           'lexicalParentRankWithinReturned50Passages':rank(lexical),'rrfRankBeforeParent20Cutoff':rank(full),
           'vectorUniqueParents':len(vectors),'lexicalUniqueParents':len(lexical),'fusedUniqueParents':len(full)}
q2=cases['q-4decb98e48faf5b6'];body=records[q2['expected'][0]]['content'];core=q2['evidence'][0]['cores'][0]
a=body.index(core)
crop={'coreStart':a,'coreEnd':a+len(core),'nearbyOriginal':body[max(0,a-180):a+len(core)+180],
      'sentSpans':rows[q2['id']]['retrieval']['provenance'][0]['spans']}
audit=read('delivery-audit.json')
positive_ids={mid for q in cases.values() for mid in q['expected']}
changed=[{**s,'usedAsPositiveSource':s['id'] in positive_ids} for s in audit['sourceAudit'] if not s['originalUnchanged']]
review=[
 {'id':q['id'],'classification':'retrieval_miss20','evidence':retrieval,
  'interpretation':'Gold source did not reach the20-parent resolver. Reconstructed only the recorded raw rankings; no new search, rerank or model call.',
  'tradeoff':'Increasing candidate depth would increase the already dominant cross-encoder work; no threshold or query-word tuning on this question.'},
 {'id':q2['id'],'classification':'evidence_crop_or_budget','evidence':crop,
  'interpretation':'Gold source ranked first after rerank, but required preceding explanation of the loss-of-control fear was omitted. Sent quote begins with a backward reference to that fear. Tight-budget fallback retained following text, source lead and a separate locator instead.',
  'tradeoff':'Complete discourse context competes with five-source breadth and the material limit. The chosen quote contains related causal content, but does not meet the frozen specific-core rule; no post-hoc credit.'},
 {'id':'q-0576f6b707326274','classification':'label_or_source_ambiguity',
  'interpretation':'Chosen alternative source explicitly describes the abstract self gaining dominance/control over the subjective world as the mechanism of security. Frozen labels accepted only a different article using dominance/dominating power. Literal alternative-core scanning missed this semantic paraphrase.',
  'tradeoff':'Not established as a model judgement error. Retain frozen wrong score; future labels require semantic alternative-source review rather than exact-string-only expansion.'},
 {'id':'q-72f2813bc892153d','classification':'label_or_source_ambiguity',
  'interpretation':'The supposed no-answer item asks whether introducing an author means the user confirmed every view as fact. A supplied source explicitly instructs retaining source-view identity and not treating collection labels as personal facts. It can support a negative/conceptual answer. Supported means an answering basis, not affirmation of the question premise.',
  'tradeoff':'Do not claim this proves model confusion of author and user, and do not relabel it to claim0false positives. Frozen1/100 remains; the no-answer acceptance evidence is not clean.'},
]
save('failure-diagnosis.json',{'at':now(),'reviewer':'Primary Codex; same family, not independent annotation',
    'scoresChanged':False,'labelsChanged':False,'modelCalls':0,'review':review,
    'sourceChanges':{'frozenSnapshotsUnchanged':80,'liveOriginalsChanged':len(changed),
        'positiveSourceOriginalsChanged':sum(s['usedAsPositiveSource'] for s in changed),'details':changed,
        'cause':'Unknown concurrent source edits; this task made0vault writes. Evaluated frozen snapshots; no original restored or overwritten.'},
    'decision':'Close this common-flow round with gaps. Do not spend the optional additional repair/retest allowance in this run; proceed to operational backend evidence. No backend adoption and no later HBM batch.',
    'qualityAcceptancePassed':False,'noAdjustedPassingScore':True})
print(json.dumps({'retrieval':retrieval,'crop':crop,'classificationCounts':{'retrieval_miss20':1,'evidence_crop_or_budget':1,'label_or_source_ambiguity':2},
    'liveOriginalsChanged':len(changed),'positiveSourceOriginalsChanged':sum(s['usedAsPositiveSource'] for s in changed)},ensure_ascii=False))
