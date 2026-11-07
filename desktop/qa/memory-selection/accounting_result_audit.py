"""Post-run stratified diagnostics only; no data, policy or score edits."""
from collections import Counter
import json
from accounting_support import read,save
from passage_index import tokenizer

if __name__=='__main__':
    summary=read('summary.json'); evaluation=read('evaluation.json')
    assert evaluation['status']=='completed' and len(evaluation['results'])==140
    cases={q['id']:q for q in read('validation.json')['cases']}
    records={r['id']:r for r in read('corpus.json')['records']}; tok=tokenizer()
    groups={}; positives=[]; failures=[]
    for row in evaluation['results']:
        q=cases[row['id']]; gold=q['expected'][0] if q['expected'] else None
        g=groups.setdefault(q['category'],{'n':0,'positive':0,'candidateHit':0,'selectedCorrect':0,'falseSelection':0})
        g['n']+=1; g['positive']+=bool(gold)
        ids=[m['id'] for m in row['candidates']]
        g['candidateHit']+=bool(gold and gold in ids)
        correct=bool(gold and gold in row['checked']['ids']);g['selectedCorrect']+=correct
        g['falseSelection']+=bool(not gold and row['checked']['ids'])
        if gold:
            ranks={k:row['retrieval'][k].index(gold)+1 if gold in row['retrieval'][k] else None for k in ['vector','lexical','fused']}
            offset=records[gold]['content'].index(q['goldSupport'])
            p={'id':q['id'],'query':q['query'],'category':q['category'],'ranks':ranks,
               'presentationPosition':ids.index(gold)+1 if gold in ids else None,
               'supportAfterTokens':len(tok.encode(records[gold]['content'][:offset],add_special_tokens=False).ids),
               'selectedCorrect':correct,'goldBodyCharacters':len(records[gold]['content'])}
            positives.append(p)
            if not correct:failures.append({**p,'checked':row['checked']})
        elif row['checked']['ids']:
            failures.append({'id':q['id'],'query':q['query'],'category':q['category'],'checked':row['checked']})
    real=groups['real/source-text']
    counts=lambda key:dict(Counter(str(p[key]) for p in positives))
    totals={'realPositive':real,'negative':100,'negativeFalseSelections':summary['quality']['negativeFalseSelections'],
            'positiveGoldRetrievalRanks':dict(Counter(str(p['ranks']['fused']) for p in positives)),
            'positiveGoldPresentationPositions':counts('presentationPosition'),
            'positiveSupportAfter512':sum(p['supportAfterTokens']>=512 for p in positives),
            'positiveSupportAfter1024':sum(p['supportAfterTokens']>=1024 for p in positives),
            'presentedAt4Or5':sum(p['presentationPosition'] in [4,5] for p in positives),
            'retrievedAt4Or5':sum(p['ranks']['fused'] in [4,5] for p in positives)}
    save('stratified-result-audit.json',{'totals':totals,'byCategory':groups,'positives':positives,'failures':failures,
       'postRunReadOnlyDiagnostic':True,'scoreOrLabelChanged':False,
       'rankMeaning':'Original retrieval rank and rotated presentation position are different. Report actual coverage even if candidate rotation supplied all tail difficulty.'})
    print(json.dumps({'totals':totals,'failures':failures},ensure_ascii=False))
