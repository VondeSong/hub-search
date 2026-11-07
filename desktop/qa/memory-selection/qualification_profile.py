"""Stage profile on retired inputs, with equality against saved old evidence."""
import hashlib
import json
import math
import os
import time
from collections import Counter
from pathlib import Path

from qualification_contract import *
import grounding_index as previous
from grounding_score import stats
from passage_index import tokenizer, terms

def old_index():
    old_work = ROOT / '.local/hbm-00/grounding-20261018c/formal-index'
    m = json.loads((old_work/'passages.json').read_text(encoding='utf-8'))
    idx = previous.Index.__new__(previous.Index)
    idx.records = {r['id']:r for r in read('corpus.json', OLD)['records']}
    idx.files, idx.passages, idx.tok = m['files'], m['passages'], tokenizer()
    idx.reranker, idx.rerank_cache, idx.by_parent = None, {}, {}
    idx.client = idx.native = None
    import jieba
    jieba.dt.tmp_dir = str(WORK/'tmp')
    jieba.initialize()
    for p in idx.passages.values():
        idx.by_parent.setdefault(p['memoryId'], []).append(p['id'])
    idx.termsets = {p['id']:set(terms(p['text'])) for p in idx.passages.values()}
    df = Counter(t for ts in idx.termsets.values() for t in ts)
    idx.idf = {t:math.log(1+len(idx.passages)/(1+n)) for t,n in df.items()}
    return idx

def profiled_resolve(idx, query, ranked, passage_order):
    all_start = phase = time.perf_counter(); times = {}
    for mid in ranked:
        assert digest(idx.files[mid]['path']) == idx.files[mid]['sha256']
    times['source_read_hash'] = (time.perf_counter()-phase)*1000
    phase = time.perf_counter()
    qt = set(terms(query)); priority = {p:i for i,p in enumerate(passage_order)}
    pairs = []
    for mid in ranked:
        pids = idx.by_parent[mid]
        lexical = sorted(pids, key=lambda p:(-sum(idx.idf.get(t,0) for t in qt & idx.termsets[p]),p))
        retrieved = sorted((p for p in pids if p in priority),key=priority.get)
        for pid in previous.base.unique(retrieved[:2]+lexical[:2]):
            p = idx.passages[pid]
            pairs.append((mid,pid,idx.records[mid]['title']+'\n'+' / '.join(previous.headings(idx.records[mid]['content'],p['start']))+'\n'+p['text']))
    times['query_terms_pair_selection'] = (time.perf_counter()-phase)*1000
    phase = time.perf_counter()
    if idx.reranker is None:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        idx.reranker = TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8', threads=2,
            cache_dir=str(ROOT/'.local/hbm-00/cache/models'), local_files_only=True)
    times['model_initialization'] = (time.perf_counter()-phase)*1000
    phase = time.perf_counter()
    scores = list(idx.reranker.rerank(query,[p[2] for p in pairs],batch_size=8)) if pairs else []
    times['cross_encoder'] = (time.perf_counter()-phase)*1000
    phase = time.perf_counter()
    best = {}
    for (mid,pid,_),score in zip(pairs,scores,strict=True):
        current = (float(score),pid)
        if mid not in best or current[0]>best[mid][0]:
            best[mid] = current
    reranked = sorted(best,key=lambda mid:(-best[mid][0],ranked.index(mid),mid))
    candidates = []
    for mid in reranked[:5]:
        r = idx.records[mid]; p = idx.passages[best[mid][1]]
        spans = previous.evidence_window(r['content'],p,idx.tok)
        source = {'origin':r.get('originId',mid),'title':r['title'],'bodySha256':hashlib.sha256(r['content'].encode()).hexdigest(),
            'recordRole':'source_text; not a user memory or confirmed real-world event',
            'leadText':previous.token_slice(r['content'],idx.tok,100),'headings':previous.headings(r['content'],p['start']),
            'attachments':'not read; links do not provide facts','offsetUnit':'Unicode characters'}
        candidates.append({'id':mid,'title':r['title'],'project':r['project'],'status':r['status'],
            'source':source,'text':'\n〔非连续原文，省略部分不得补推〕\n'.join(s['text'] for s in spans),
            'spans':[{'start':s['start'],'end':s['end'],'sha256':hashlib.sha256(s['text'].encode()).hexdigest()} for s in spans]})
    times['evidence_pack'] = (time.perf_counter()-phase)*1000
    phase = time.perf_counter()
    for m in candidates:
        r = idx.records[m['id']]
        for s in m['spans']:
            assert hashlib.sha256(r['content'][s['start']:s['end']].encode()).hexdigest()==s['sha256']
    count = len(idx.tok.encode(json.dumps(candidates,ensure_ascii=False),add_special_tokens=False).ids)
    assert count<=6000
    times['provenance_budget_check'] = (time.perf_counter()-phase)*1000
    return {'timesMs':times,'totalMs':(time.perf_counter()-all_start)*1000,'pairs':len(pairs),
            'reranked':reranked,'candidates':candidates,'tokens':count}

def main():
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    contract=read('scope-contract.json')
    save('profile-contract.json', {'at':now(),'sourceSha256':digest(__file__),
        'profile':contract['profile'],'scopeSha256':digest(REPORTS/'scope-contract.json'),
        'oldEvaluationSha256':digest(OLD/'evaluation.json'),'newSourcesRead':False,
        'note':'Instrumentation adds provenance validation; algorithm, threads, model, inputs unchanged; no result cache.'})
    cases={q['id']:q for q in read('validation.json',OLD)['cases']}
    rows={r['id']:r for r in read('evaluation.json',OLD)['rows'] if r['backend']=='hub-native-hybrid'}
    idx=old_index();output=[];began=time.perf_counter()
    for i,qid in enumerate(contract['profile']['sameInputIds'],1):
        r=rows[qid]['retrieval']
        result=profiled_resolve(idx,cases[qid]['query'],r['preRerank'],previous.base.fuse(r['vectorPassages'],r['lexicalPassages']))
        assert result['candidates']==r['candidates'], 'Profile changed original evidence'
        assert result['reranked']==r['reranked'], 'Profile changed original order'
        result.update({'id':qid,'ordinal':i,'oldEvidenceEqual':True})
        save(f'profile-before-{i:02}.json',result);output.append(result)
        print(json.dumps({'profileCompleted':i,'total':20,'totalMs':round(result['totalMs'],2),'pairs':result['pairs']}),flush=True)
    summary={'at':now(),'n':len(output),'sameEvidenceAll':True,'allMs':stats([r['totalMs'] for r in output]),
        'hotMs':stats([r['totalMs']-r['timesMs']['model_initialization'] for r in output]),
        'stages':{k:stats([r['timesMs'][k] for r in output]) for k in output[0]['timesMs']},
        'wallMs':(time.perf_counter()-began)*1000,'inputIds':contract['profile']['sameInputIds'],
        'backendQueryTimes':'Separate prior native/BM vector and actual Hub lexical stage receipts retained in old measurement-context; this experiment isolates common resolver.',
        'newDataRead':False,'modelCalls':0}
    save('profile-before.json',summary)
    print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
