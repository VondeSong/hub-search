"""Post-score failure evidence projection; never alters the frozen labels."""
import json
from qualification_contract import *

cases={q['id']:q for q in read('validation.json')['cases']}
records={r['id']:r for r in read('corpus.json')['records']}
rows={r['id']:r for r in read('evaluation.json')['rows']}
for item in read('delivery-audit.json')['failureReviewQueue']:
    q=cases[item['id']];r=rows[q['id']];found=r['retrieval']
    chosen=set(r['checked']['ids'])
    print(json.dumps({'id':q['id'],'category':item['automaticCategory'],'question':q['query'],
        'negativeCategory':q['category'] if not q['expected'] else None,
        'rationale':q.get('rationale'),'absenceAudit':q.get('absenceAudit'),
        'expectedEvidence':q['evidence'],'decision':r['checked'],
        'preRerank':found['preRerank'],'fused':found['fused'],
        'goldSourceTitles':{mid:records[mid]['title'] for mid in q['expected']},
        'candidateEvidence':[m for m in found['candidates'] if m['id'] in set(q['expected'])|chosen],
        'originSpans':[p for p in found['provenance'] if p['id'] in set(q['expected'])|chosen]},ensure_ascii=False))
