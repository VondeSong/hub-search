"""The preregistered lexical-only control; zero generative calls or vector tuning."""
import json
from parity_support import *
from parity_index import Index, unique

if __name__=='__main__':
    corpus=read('corpus.json'); questions=read('validation.json')['cases']
    save('native-control-start.json',{'at':now(),'role':'Preregistered supplementary Hub lexical-only control, NOT either primary hybrid arm.',
        'corpusSha256':digest(REPORTS/'corpus.json'),'validationSha256':digest(REPORTS/'validation.json'),
        'queryMethodsChanged':False,'modelCalls':0,'executionsMax':1,
        'reason':'Do not infer native availability from a BM-gated experimental initialization. Preserve useful native lexical evidence even if primary paired run cannot initialize.',
        'futureReuse':'Consume this exact native receipt, verified against its input hash, rather than rerun these lexical queries.'})
    index=Index.__new__(Index);index.root=WORK/'formal-index'
    manifest=json.loads((index.root/'passages.json').read_text(encoding='utf-8'))
    index.records={r['id']:r for r in corpus['records']}
    index.files,index.passages=manifest['files'],manifest['passages']
    for item in index.files.values():
        assert digest(item['path'])==item['sha256']
    results=index.native_lexical(questions,read('native-harness.json'),'formal')
    out=[];hit5=hit20=0
    for q in questions:
        parents=unique(index.passages[pid]['memoryId'] for pid in results[q['id']]['ids'])
        if q['expected']:
            hit5+=bool(set(q['expected'])&set(parents[:5]))
            hit20+=bool(set(q['expected'])&set(parents[:20]))
        ranks=[parents.index(mid)+1 for mid in q['expected'] if mid in parents]
        out.append({'id':q['id'],'parents':parents,'bestGoldRank':min(ranks) if ranks else None,
                    'positive':bool(q['expected']),'elapsedMs':results[q['id']]['elapsedMs']})
    save('native-lexical-control.json',{'at':now(),'status':'completed','kind':'Supplementary lexical ONLY; no final applicability/no-answer metric.',
        'questions':124,'positive':24,'hitAt5':hit5,'recallAt5':hit5/24,'hitAt20':hit20,'recallAt20':hit20/24,
        'fullNativeReceipt':index.lexical_receipt,'rows':out,'modelCalls':0,'primaryHybridComparisonCompleted':False})
    print(json.dumps({'nativeLexicalRecallAt5':hit5/24,'hit5':hit5,'positive':24,'primaryHybridComparisonCompleted':False}))
