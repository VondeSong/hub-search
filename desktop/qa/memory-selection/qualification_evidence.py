"""Exact paragraph/continuation evidence under an explicitly estimated budget.

No benchmark labels, IDs, answers, special vocabulary, or source-title rules.
Full provenance is kept at the host; the model sees a compact source projection.
"""
import hashlib
import json
import re
import tiktoken

GAP='\n〔非连续原文，省略部分不得补推〕\n'

class Budget:
    limit=2000
    reserve=0.25
    def __init__(self):
        self.encodings=[tiktoken.get_encoding(n) for n in ['o200k_base','cl100k_base']]
        try:
            self.model_encoding=tiktoken.encoding_for_model('gpt-6.1-sol')
        except KeyError:
            self.model_encoding=None

    def count(self,value):
        text=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,separators=(',',':'))
        return max(len(e.encode(text,disallowed_special=())) for e in self.encodings)

    def fits(self,value):
        return self.count(value)<=int(self.limit*(1-self.reserve))

    def receipt(self,value):
        return {'estimatedTextTokens':self.count(value),'ceiling':1500,'productLimit':self.limit,
            'reserveFraction':self.reserve,'counter':'max(o200k_base,cl100k_base), compact candidate JSON including sources',
            'solMappingVerified':False,'exactModelBudgetPassed':False,
            'meaning':'Conservative local estimate only;25% reserved, not proof of exact Sol input-token count'}

def paragraphs(text):
    return [m.span() for m in re.finditer(r'\S[\s\S]*?(?=\n\s*\n|\Z)',text)]

def sentences(text,left,right):
    """Keep terminal punctuation; never detach a negative word from its clause."""
    result=[];a=left
    for m in re.finditer(r'[。！？]+[”’」』"]*|[!?]+(?=\s|$)|\r?\n',text[left:right]):
        b=left+m.end()
        if text[a:b].strip():result.append((a,b))
        a=b
    if text[a:right].strip():result.append((a,right))
    return result or [(left,right)]

def merge(ranges,text=None):
    out=[]
    for a,b in sorted(set(ranges)):
        if out and (a<=out[-1][1] or text is not None and not text[out[-1][1]:a].strip()):out[-1]=(out[-1][0],max(b,out[-1][1]))
        else:out.append((a,b))
    return out

def proposals(text,hit,locator=None,query_terms=()):
    """Largest context first; progressively smaller COMPLETE language units.

    Both directions are included. A secondary lexical locator is independent of
    the semantic hit and may preserve the example used to identify the source.
    """
    ps=paragraphs(text)
    touched=[i for i,(a,b) in enumerate(ps) if a<hit['end'] and b>hit['start']]
    if not touched:return []
    first,last=min(touched),max(touched)
    core=[ps[i] for i in range(first,last+1)]
    before=sentences(text,*ps[first-1])[-2:] if first else []
    after=sentences(text,*ps[last+1])[:2] if last+1<len(ps) else []
    adjacent=merge([*before,*core,*after])
    located=[]
    if locator:
        located=[(a,b) for a,b in ps if a<locator['end'] and b>locator['start']]
    variants=[(merge(adjacent+located,text),'paragraphs+both-side-sentences+query-locator')]
    # A very long paragraph may not fit. Offer sentence-aligned hit context;
    # explicitly mark that the complete paragraph was not delivered.
    ss=[s for i in touched for s in sentences(text,*ps[i])]
    touched_sentences=[i for i,(a,b) in enumerate(ss) if a<hit['end'] and b>hit['start']]
    if touched_sentences:
        lo,hi=min(touched_sentences),max(touched_sentences)
        locator_sentences=[s for a,b in located for s in sentences(text,a,b)]
        if locator_sentences:
            # A distinct locator mentioned by the user is evidence too. Keep its
            # best complete sentence along with semantic support BEFORE spending
            # the budget on a longer support-only window or decorative lead-in.
            facet_terms=locator.get('locatorTerms',query_terms)
            weights=facet_terms if isinstance(facet_terms,dict) else {t:1 for t in facet_terms}
            anchor=max(locator_sentences,key=lambda s:sum(w for t,w in weights.items() if t.lower() in text[s[0]:s[1]].lower()))
            variants.append((merge([*ss[lo:hi+1],*after,anchor],text),'whole-hit+following+query-locator-incomplete-paragraph'))
            variants.append((merge([*ss[max(lo,hi-1):hi+1],anchor],text),'hit-end+query-locator-incomplete-paragraph'))
    variants.extend([(adjacent,'paragraphs+both-side-sentences'),
        (merge([*core,*after],text),'paragraphs+following-continuation'),(merge(core,text),'whole-hit-paragraphs')])
    if touched_sentences:
        lo,hi=min(touched_sentences),max(touched_sentences)
        # A passage can cover many sentences. The old start-only fallback lost
        # its latter half and the answer that followed it. Preserve the complete
        # hit through its END before considering any shorter, flagged fallback.
        variants.append((merge(ss[max(0,lo-1):min(len(ss),hi+3)]+after),'whole-hit+continuation-incomplete-paragraph'))
        variants.append((merge(ss[lo:hi+1]+after),'whole-hit+following-incomplete-paragraph'))
        variants.append((merge(ss[max(lo,hi-1):min(len(ss),hi+3)]+after),'hit-end+continuation-incomplete-paragraph'))
        variants.append(([ss[hi]],'hit-end-sentence-incomplete-paragraph'))
    unique=[];seen=set()
    for ranges,kind in variants:
        key=tuple(ranges)
        if key not in seen:
            seen.add(key);unique.append((ranges,kind))
    return unique

def source_lead(text):
    start=0
    if text.startswith('---'):
        m=re.search(r'\r?\n---(?:\r?\n|$)',text[3:])
        if m:start=3+m.end()
    for a,b in paragraphs(text[start:]):
        a+=start;b+=start
        if not text[a:b].lstrip().startswith(('#','---','> [!')):
            units=sentences(text,a,b)
            return units[0] if units and units[0][1]-units[0][0]<=180 else None
    return None

def make_candidate(record,ranges,kind,heading):
    text=record['content']
    spans=[{'start':a,'end':b,'sha256':hashlib.sha256(text[a:b].encode()).hexdigest()} for a,b in merge(ranges,text)]
    value={'id':record['id'],'title':record['title'],'project':record['project'],'status':record['status'],
        'source':{'recordRole':'source_text; not a confirmed user event','headings':heading},
        'text':GAP.join(text[s['start']:s['end']] for s in spans)}
    audit={'id':record['id'],'origin':record.get('originId',record['id']),
        'bodySha256':hashlib.sha256(text.encode()).hexdigest(),'spans':spans,
        'kind':kind,'paragraphIncomplete':'incomplete' in kind,'offsetUnit':'Unicode characters'}
    return value,audit

def pack(records,ranked,hits,locators,heading_fn,budget=None,query_terms=()):
    budget=budget or Budget()
    mids=ranked[:5]
    candidates=[];audit=[];options=[]
    # Reserve compact identity/role for every source before allocating evidence.
    for mid in mids:
        r=records[mid];hit=hits[mid]
        heading=heading_fn(r['content'],hit['start'])
        empty,origin=make_candidate(r,[],'no-complete-unit-fits',heading)
        empty['contextIncomplete']=True
        candidates.append(empty);audit.append(origin)
        variants=[]
        for ranges,kind in proposals(r['content'],hit,locators.get(mid),query_terms):
            lead=source_lead(r['content'])
            if lead and not any(a<=lead[0] and b>=lead[1] for a,b in ranges):
                variants.append((merge([lead,*ranges]),kind+'+source-lead'))
            variants.append((ranges,kind))
        options.append(variants)
    if not budget.fits(candidates):
        raise ValueError('Five source identities alone exceed material budget; explicit product decision required')
    # Weighted allocation protects space for lower-ranked evidence rather than
    # dropping sources. Subsequent pass redistributes unused allowance.
    base=budget.count(candidates);room=1500-base
    weights=[.40,.22,.16,.12,.10][:len(mids)]
    allocated={i:int(room*w/sum(weights)) for i,w in enumerate(weights)}
    for redistribute in [False,True]:
        for i,mid in enumerate(mids):
            old_cost=budget.count(candidates[i])
            existing_len=len(candidates[i]['text'])
            for ranges,kind in options[i]:
                v,a=make_candidate(records[mid],ranges,kind,heading_fn(records[mid]['content'],hits[mid]['start']))
                if len(v['text'])<existing_len:continue
                v['contextIncomplete']='incomplete' in kind
                if not redistribute and budget.count(v)-old_cost>allocated[i]:continue
                trial=candidates.copy();trial[i]=v
                if budget.fits(trial):
                    candidates[i]=v;audit[i]=a
                    break
    for c,a in zip(candidates,audit,strict=True):
        original=records[c['id']]['content']
        assert c['text']==GAP.join(original[s['start']:s['end']] for s in a['spans'])
        assert all(hashlib.sha256(original[s['start']:s['end']].encode()).hexdigest()==s['sha256'] for s in a['spans'])
    assert budget.fits(candidates)
    return candidates,audit,budget.receipt(candidates)
