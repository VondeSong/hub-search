"""Common query compiler, full-parent evidence resolution and provenance.

Both stores keep the same independently embedded representation as parity C.
The local cross encoder is shared evidence processing, not backend evidence.
No expected IDs, answers, labels or benchmark-specific vocabulary is consumed.
"""
import hashlib
import json
import math
import re
import time
from collections import Counter

from grounding_support import ROOT, WORK, digest
import parity_index as base
from passage_index import terms

base.WORK = WORK

def lexical_query(query):
    # Explicit OR is required by Hub's default-AND QueryParser contract.
    # Quote each term so user punctuation cannot turn into field/Boolean syntax.
    words = terms(query)
    return ' OR '.join('"' + w.replace('\\','\\\\').replace('"','\\"') + '"' for w in words) if words else '"__hbm_empty_query__"'

def headings(text, offset):
    stack = []
    for m in re.finditer(r'(?m)^ {0,3}(#{1,6})\s+([^\r\n]+)', text[:offset]):
        level = len(m[1])
        stack = [(n,t) for n,t in stack if n < level]
        stack.append((level,m[2]))
    return [t for _,t in stack]

def token_slice(text, tok, limit, tail=False):
    encoded = tok.encode(text, add_special_tokens=False)
    if len(encoded.ids) <= limit:
        return text
    return text[encoded.offsets[-limit][0]:] if tail else text[:encoded.offsets[limit-1][1]]

def evidence_window(text, passage, tok, budget=550):
    """Expand to the original paragraph, then preserve leading qualification.

    Long paragraphs get their first 120 tokens plus a contiguous 400-token
    neighborhood around the hit. Every range remains exact original text.
    The marker between disjoint ranges explicitly cannot support a quotation.
    """
    start, end = passage['start'], passage['end']
    breaks = list(re.finditer(r'\n\s*\n', text))
    left = max([m.end() for m in breaks if m.end() <= start] or [0])
    right = min([m.start() for m in breaks if m.start() >= end] or [len(text)])
    paragraph = text[left:right]
    enc = tok.encode(paragraph, add_special_tokens=False)
    if len(enc.ids) <= budget:
        ranges = [(left,right)]
        # Nearby lead-in frequently carries speaker/genre/negation identity.
        if left:
            previous = max([m.end() for m in breaks if m.end() < left-2] or [0])
            prev = token_slice(text[previous:left],tok,min(140,budget-len(enc.ids)),tail=True) if len(enc.ids) < budget else ''
            if prev.strip():
                ranges.insert(0,(left-len(prev),left))
    else:
        # Token offsets are relative to the paragraph, never decoded/reformatted.
        centre = next((i for i,(_,b) in enumerate(enc.offsets) if left+b > start),0)
        lo = max(0,centre-100); hi = min(len(enc.ids),lo+400)
        lo = max(0,hi-400)
        ranges = [(left,left+enc.offsets[min(119,len(enc.ids)-1)][1]),
                  (left+enc.offsets[lo][0],left+enc.offsets[hi-1][1])]
    merged=[]
    for a,b in sorted(ranges):
        if merged and a<=merged[-1][1]:
            merged[-1]=(merged[-1][0],max(b,merged[-1][1]))
        else:
            merged.append((a,b))
    return [{'start':a,'end':b,'text':text[a:b]} for a,b in merged if text[a:b].strip()]

class Index(base.Index):
    def __init__(self, corpus, name):
        super().__init__(corpus,name)
        # Preserve decoded original newline characters on Windows. The inherited
        # prototype used text-mode newline translation when writing snapshots.
        for mid,r in self.records.items():
            path=self.files[mid]['path']
            from pathlib import Path
            Path(path).write_bytes(r['content'].encode('utf-8'))
            self.files[mid]['sha256']=digest(path)
        for p in self.passages.values():
            note=self.state/'notes'/p['project']/(p['id']+'.md')
            note.write_bytes(('---\ntitle: '+json.dumps(p['title'],ensure_ascii=False)+
                f'\ntype: note\npermalink: {p["id"]}\n---\n\n{p["text"]}\n').encode('utf-8'))
        base.bm.save(self.root/'passages.json',{'files':self.files,'passages':self.passages})
        self.reranker = None
        self.by_parent = {}
        for p in self.passages.values():
            self.by_parent.setdefault(p['memoryId'],[]).append(p['id'])
        self.termsets = {p['id']:set(terms(p['text'])) for p in self.passages.values()}
        df=Counter(t for ts in self.termsets.values() for t in ts)
        self.idf={t:math.log(1+len(self.passages)/(1+n)) for t,n in df.items()}
        self.rerank_cache={}

    def native_input(self, questions, name):
        path=self.root/(name+'-native-input.json')
        data={'format':'hbm-parity-native-input-v1','projects':sorted({r['project'] for r in self.records.values()}),
              'passages':list(self.passages.values()),'queries':[{'id':q['id'],'project':q['project'],
              'lexicalQuery':lexical_query(q['query'])} for q in questions]}
        with path.open('x',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False)
        return path

    def resolve(self, query, ranked, passage_order):
        key=hashlib.sha256(json.dumps([query,ranked,passage_order],ensure_ascii=False).encode()).hexdigest()
        if key in self.rerank_cache:
            result=self.rerank_cache[key]
            return {**result,'sharedIdenticalEvidenceResolution':True,'observedResolutionMs':0.0}
        began=time.perf_counter()
        qt=set(terms(query)); priority={p:i for i,p in enumerate(passage_order)}
        pairs=[]
        for mid in ranked:
            assert digest(self.files[mid]['path'])==self.files[mid]['sha256']
            pids=self.by_parent[mid]
            lexical=sorted(pids,key=lambda p:(-sum(self.idf.get(t,0) for t in qt & self.termsets[p]),p))
            retrieved=sorted((p for p in pids if p in priority),key=priority.get)
            # Two best raw hits + two independent full-parent lexical windows.
            # This allows evidence outside raw K to be read without global scan.
            for pid in base.unique(retrieved[:2]+lexical[:2]):
                p=self.passages[pid]
                pairs.append((mid,pid,self.records[mid]['title']+'\n'+' / '.join(headings(self.records[mid]['content'],p['start']))+'\n'+p['text']))
        if self.reranker is None:
            from fastembed.rerank.cross_encoder import TextCrossEncoder
            self.reranker=TextCrossEncoder(model_name='BAAI/bge-reranker-v2-m3-int8',threads=2,
                cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True)
        scores=list(self.reranker.rerank(query,[p[2] for p in pairs],batch_size=8)) if pairs else []
        best={}
        for (mid,pid,_),score in zip(pairs,scores,strict=True):
            current=(float(score),pid)
            if mid not in best or current[0]>best[mid][0]:best[mid]=current
        reranked=sorted(best,key=lambda mid:(-best[mid][0],ranked.index(mid),mid))
        candidates=[]
        for mid in reranked[:5]:
            r=self.records[mid]; p=self.passages[best[mid][1]]
            spans=evidence_window(r['content'],p,self.tok)
            lead=token_slice(r['content'],self.tok,100)
            source={'origin':r.get('originId',mid),'title':r['title'],'bodySha256':hashlib.sha256(r['content'].encode()).hexdigest(),
                    'recordRole':'source_text; not a user memory or confirmed real-world event',
                    'leadText':lead,'headings':headings(r['content'],p['start']),
                    'attachments':'not read; links do not provide facts', 'offsetUnit':'Unicode characters'}
            candidates.append({'id':mid,'title':r['title'],'project':r['project'],'status':r['status'],
                'source':source,'text':'\n〔非连续原文，省略部分不得补推〕\n'.join(s['text'] for s in spans),
                'spans':[{'start':s['start'],'end':s['end'],'sha256':hashlib.sha256(s['text'].encode()).hexdigest()} for s in spans]})
        # Keep all five sources; shorten each independently before global packing.
        # Budget is deliberately larger than C and is reported, not called a gain.
        count=len(self.tok.encode(json.dumps(candidates,ensure_ascii=False),add_special_tokens=False).ids)
        assert count<=6000, 'Evidence packing exceeded frozen budget; fail, never silently drop a source'
        result={'reranked':reranked,'candidates':candidates,'bestPassages':{mid:best[mid][1] for mid in best},
                'rerankPairs':len(pairs),'memoryBgeTokens':count,'sharedIdenticalEvidenceResolution':False,
                'observedResolutionMs':(time.perf_counter()-began)*1000}
        self.rerank_cache[key]=result
        return result

    def retrieve(self, question, lexical, backend):
        began=time.perf_counter()
        vec=self.vector_search(question['query'],question['project'],backend)
        parent=lambda ids:base.unique(self.passages[p]['memoryId'] for p in ids)
        ranked=base.fuse(parent(vec['passages']),parent(lexical['ids']))[:20]
        order=base.fuse(vec['passages'],lexical['ids'])
        resolved=self.resolve(question['query'],ranked,order)
        return {**resolved,'fused':resolved['reranked'],'preRerank':ranked,
                'vector':parent(vec['passages'])[:20],'lexical':parent(lexical['ids'])[:20],
                'vectorPassages':vec['passages'],'lexicalPassages':lexical['ids'],
                'excluded':base.unique(vec['excluded']+lexical['excluded']), 'budgetDropped':[],
                'vectorMs':vec['ms'],'retrievalMs':(time.perf_counter()-began)*1000+lexical['elapsedMs']}
