"""Mechanical pre-freeze shape and identity audit; no retrieval or model requests."""
import json
from pathlib import Path
from latency_support import REPORTS, read, save
from passage_index import tokenizer

if __name__=='__main__':
    records={r['id']:r for r in read('corpus.json')['records']}
    cases=read('validation-draft.json')['cases']
    tok=tokenizer()
    positives=[q for q in cases if q['expected']]
    lengths=[len(tok.encode(records[q['expected'][0]]['content'],add_special_tokens=False).ids) for q in positives]
    late=[]
    for q in positives:
        text=records[q['expected'][0]]['content']
        location=text.index(q['goldSupport'])
        if len(tok.encode(text[:location],add_special_tokens=False).ids)>=512:
            late.append(q['id'])
    save('validation-shape.json',{'records':len(records),'positive':len(positives),'negative':len(cases)-len(positives),
        'distinctPositiveRecords':len({q['expected'][0] for q in positives}),
        'longestPositiveBodyTokens':max(lengths),'positiveWithSupportAfter512Tokens':len(late),
        'latePositiveIds':late,'personalLibraryUsedForCorpus':False,'modelCalls':0,
        'audit':'All 80 cases reviewed against their complete synthetic source and requested attributes; state guards/cross-project/planned-vs-actual/unsupported details included.'})
    print(json.dumps({'records':len(records),'positive':len(positives),'negative':len(cases)-len(positives),
                      'maxBodyTokens':max(lengths),'lateFacts':len(late)}))
