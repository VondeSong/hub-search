"""Offline failure projection; cannot change frozen labels or scores."""
import json
from collections import Counter
from grounding_support import *

def main():
    scored=read('scored-results.json');evaluation=read('evaluation.json')
    cases={q['id']:q for q in read('validation.json')['cases']}
    records={r['id']:r for r in read('corpus.json')['records']}
    projected=[];counts={}
    for backend,data in scored.items():
        events=Counter()
        rows={r['id']:r for r in evaluation['rows'] if r['backend']==backend}
        for d in data['details']:
            q=cases[d['id']];row=rows[q['id']];r=row['retrieval'];checked=row['checked']
            if q['expected']:
                if d['selectedCorrect']:continue
                if not d['finalRank']:reason='parent_missing_from20'
                elif not d['candidateHit']:reason='parent_outside5'
                elif not d['evidenceDelivered']:reason='frozen_core_not_delivered'
                elif not checked['ids']:reason='abstention_or_protocol_rejection'
                elif not d['selectedSourceCorrect']:reason='different_source_selected'
                else:reason='same_source_quote_did_not_match_prospective_core'
            else:
                if not checked['ids'] and not checked['invalid']:continue
                reason='no_answer_false_selection' if checked['ids'] else 'invalid_protocol'
            events[reason]+=1
            selected=[m for m in r['candidates'] if m['id'] in checked['ids']]
            expected=[m for m in r['candidates'] if m['id'] in q['expected']]
            projected.append({'backend':backend,'id':q['id'],'query':q['query'],'category':q['category'],
                'reason':reason,'initialRank':d['initialRank'],'finalRank':d['finalRank'],
                'expectedTitles':[records[mid]['title'] for mid in q['expected']],
                'answerFact':q.get('answerFact'),'frozenEvidence':q['evidence'],'checked':checked,
                'selected':[{'id':m['id'],'title':m['title'],'source':m['source'],'text':m['text']} for m in selected],
                'expectedDelivered':[{'id':m['id'],'title':m['title'],'text':m['text']} for m in expected]})
        counts[backend]=dict(events)
    save('failure-input.json',{'at':now(),'counts':counts,'rows':projected,'scoreChanged':False,
        'note':'Exact-core failure classes are diagnostics; unlisted semantic equivalents require explicit caveat, never posthoc score repair.'})
    print(json.dumps({'failureClasses':counts,'diagnosticRows':len(projected),'scoreChanged':False},ensure_ascii=False))

if __name__=='__main__':main()
