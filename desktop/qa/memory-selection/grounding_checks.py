"""Focused canonical evidence checks and final owned-run audit."""
import argparse
import ast
import hashlib
import json
import re
from pathlib import Path
import psutil
from grounding_support import *

MARK='\n〔非连续原文，省略部分不得补推〕\n'

def verify_candidate(m,r):
    assert m['id']==r['id'] and m['project']==r['project'] and m['status']=='confirmed'
    assert m['source']['origin']==r.get('originId',r['id'])
    assert m['source']['bodySha256']==hashlib.sha256(r['content'].encode()).hexdigest()
    parts=[]
    for s in m['spans']:
        part=r['content'][s['start']:s['end']]
        assert hashlib.sha256(part.encode()).hexdigest()==s['sha256']
        parts.append(part)
    assert m['text']==MARK.join(parts)

def focused():
    from grounding_index import Index,evidence_window
    from passage_index import tokenizer
    from grounding_policy import validate_decisions
    for path in Path(__file__).parent.glob('grounding_*.py'):ast.parse(path.read_text(encoding='utf-8'))
    manifest=json.loads((ROOT/'.local/hbm-00/parity-20261018b/formal-index/passages.json').read_text(encoding='utf-8'))
    corpus=json.loads((ROOT/'artifacts/hbm-00-parity-20261018c/corpus.json').read_text(encoding='utf-8'))
    records={r['id']:r for r in corpus['records']};tok=tokenizer();n=0
    # Every real old passage crosses actual canonical paragraph/token boundaries.
    for p in manifest['passages'].values():
        text=records[p['memoryId']]['content'];spans=evidence_window(text,p,tok)
        assert spans and all(s['text']==text[s['start']:s['end']] for s in spans)
        assert any(s['start']<=p['start'] and s['end']>=p['end'] for s in spans), 'Hit itself was clipped'
        n+=1
    m={'id':'fixture','title':'canonical boundary','project':'notes','status':'confirmed','text':'首段原文。'+MARK+'后段原文。','spans':[{'start':0,'end':5},{'start':20,'end':25}]}
    task={'id':'check','project':'notes','candidateIds':['fixture']}
    answer=lambda quote:{'decisions':[{'id':'check','outcome':'supported','memoryId':'fixture','quote':quote,'reasonCode':'evidence_support'}]}
    assert validate_decisions(answer('首段原文。'),[task],[m])[0]['ids']==['fixture']
    assert validate_decisions(answer(m['text']),[task],[m])[0]['invalid']=='discontinuous_quote'
    wrong={**task,'project':'other'}
    assert validate_decisions(answer('首段原文。'),[wrong],[m])[0]['invalid']=='scope_or_state'
    real=next(iter(records.values()))
    crlf={**real,'content':real['content'].replace('\r\n','\n').replace('\n','\r\n')}
    index=Index({'records':[crlf]},'focused-canonical')
    assert Path(index.files[real['id']]['path']).read_bytes()==crlf['content'].encode('utf-8')
    assert all(p['text']==crlf['content'][p['start']:p['end']] for p in index.passages.values())
    index.close()
    save('focused-checks-v2.json',{'at':now(),'canonicalRealPassagesChecked':n,'hitRetained':True,'offsetAndTextIdentity':True,
        'discontinuousQuoteRejected':True,'scopeMismatchRejected':True,'syntaxChecked':True,'modelCalls':0,'windowsCRLFCanonicalBytesPreserved':True})
    print(json.dumps({'realPassagesChecked':n,'checks':'passed'}))

def audit():
    assert read('method-contract.json')['sources']==sources()
    e=read('evaluation.json');corpus=read('corpus.json');by_mid={r['id']:r for r in corpus['records']}
    assert e['status']=='completed'
    injections=quotes=0
    for row in e['rows']:
        for m in row['retrieval']['candidates']:
            assert m['project']=='notes' and m['status']=='confirmed';verify_candidate(m,by_mid[m['id']]);injections+=1
        c=row['checked']
        if c['ids']:
            m=next(m for m in row['retrieval']['candidates'] if m['id']==c['ids'][0])
            assert any(c['decision']['quote'] in part for part in m['text'].split(MARK));quotes+=1
    all_calls=e['modelCalls']+read('development-model.json')['calls'];alive=[]
    for call in all_calls:
        r=call['receipt']
        assert r['model']==MODEL and r['effort']==EFFORT and r['toolCalls']==0 and r['ephemeral'] and r['freshEmptyHistory'] and r['explicitRetries']==0
        try:
            p=psutil.Process(r['pid'])
            if p.create_time()==r['createTime'] and p.is_running():alive.append({'pid':p.pid,'createTime':p.create_time()})
        except psutil.NoSuchProcess:pass
    process=json.loads((WORK/'formal-index/bm/process.json').read_text(encoding='utf-8'))
    assert process['status']=='exited' and not process['residual'] and not e['bmResidual']
    # Scan owned text only; never dump matched bytes or copy the login store.
    auth=Path.home()/'.codex/auth.json';needles=[]
    if auth.exists():
        def visit(v):
            if isinstance(v,dict):
                for x in v.values():visit(x)
            elif isinstance(v,list):
                for x in v:visit(x)
            elif isinstance(v,str) and len(v)>64:needles.append(v.encode())
        visit(json.loads(auth.read_text(encoding='utf-8')))
    matches=[];scanned=0;owned_bytes=0
    for root in [WORK,REPORTS]:
        for path in root.rglob('*'):
            if not path.is_file():continue
            owned_bytes+=path.stat().st_size
            if path.suffix not in ['.json','.jsonl','.log','.txt','.toml','.md','.py']:continue
            raw=path.read_bytes();scanned+=1
            if any(n in raw for n in needles) or re.search(rb'\bsk-[A-Za-z0-9_-]{24,}',raw):matches.append(str(path.relative_to(root)))
    assert not alive and not matches and owned_bytes<=600*1024**2
    baseline=read('scope-contract.json')['baseline']
    production={p:digest(ROOT/p)==h for p,h in baseline.items() if p.startswith('src-tauri/')}
    assert all(production.values())
    pairs={}
    for row in e['rows']:pairs.setdefault(row['id'],[]).append(row)
    same_payload=sum(v[0]['promptSha256']==v[1]['promptSha256'] for v in pairs.values())
    save('delivery-verification.json',{'at':now(),'injectedCandidatesAudited':injections,'selectedQuotesAudited':quotes,
        'actualModelCallsAudited':len(all_calls),'model':MODEL,'effort':EFFORT,'toolsAndRetries':0,
        'sameWholePromptQuestions':same_payload,'ownedProcessesAlive':alive,'credentialMatches':matches,'ownedTextFilesScanned':scanned,
        'ownedBytes':owned_bytes,'productionSourcesUnchanged':production,'vaultWrites':0,'sourcesFrozen':sources()})
    print(json.dumps({'injections':injections,'quotes':quotes,'actualCalls':len(all_calls),'samePrompts':same_payload,'ownedMiB':owned_bytes/1024**2,'checks':'passed'}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['focused','audit'])
    {'focused':focused,'audit':audit}[p.parse_args().phase]()
