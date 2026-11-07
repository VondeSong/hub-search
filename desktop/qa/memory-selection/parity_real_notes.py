"""Read-only prospective sampling. Full source bytes kept outside the vault."""
import hashlib
import json
import re
import subprocess
from parity_support import *
from passage_index import tokenizer

if __name__=='__main__':
    method=read('method-contract.json'); scope=read('scope-contract.json')
    old=json.loads((ROOT/'artifacts/hbm-00-accounting-20261018/real-notes.json').read_text(encoding='utf-8'))
    excluded={Path(s['path']).resolve() for s in old['sources']}
    groups=[]; inventory=[]; tok=tokenizer()
    for relative in scope['newData']['clusters']+scope['newData']['fallbackClusters']:
        folder=VAULT/relative
        if len(groups)==3:
            break
        paths=[]
        if folder.exists():
            listing=subprocess.run(['rg','--files',str(folder),'-g','*.md','-g','!.obsidian/**','-g','!AGENTS.md'],capture_output=True,check=True)
            paths=[Path(p) for p in listing.stdout.decode('utf-8').splitlines()]
        paths.sort(key=lambda p:hashlib.sha256(p.relative_to(VAULT).as_posix().encode()).hexdigest())
        eligible=[]; scanned=0
        for path in paths:
            if path.resolve() in excluded or not 700<=path.stat().st_size<=72000:
                continue
            assert path.resolve().is_relative_to(VAULT.resolve())
            scanned+=1
            text=path.read_bytes().decode('utf-8-sig')
            if not 700<=len(text)<=18000 or '\x00' in text:
                continue
            if re.search(r'\b(?:sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.)',text):
                raise RuntimeError('Possible credential in source; do not export')
            eligible.append(path)
            if len(eligible)==24:
                break
        inventory.append({'cluster':relative,'listed':len(paths),'contentRead':scanned,'eligiblePrefixCount':len(eligible),
                          'used':len(eligible)>=8,'allEligibleCountKnown':len(eligible)<24})
        if len(eligible)>=8:
            groups.append((relative,eligible[:16],eligible[16:20]))
    assert len(groups)==3, 'Insufficient prospective clusters; stop before question authoring'
    root=WORK/'real-note-snapshots'; root.mkdir(exist_ok=False)
    records=[]; sources=[]
    for group,selected,guards in groups:
        for path in selected:
            raw=path.read_bytes(); text=raw.decode('utf-8-sig')
            mid='m-'+hashlib.sha256(('parity/'+path.relative_to(VAULT).as_posix()).encode()).hexdigest()[:16]
            (root/(mid+'.md')).write_bytes(raw)
            source={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'snapshot':str(root/(mid+'.md')),
                    'isWholeNote':True,'characters':len(text),'tokens':len(tok.encode(text,add_special_tokens=False).ids),
                    'offsetUnit':'Unicode characters after UTF-8-sig decode; original newline characters retained'}
            records.append({'id':mid,'originId':path.relative_to(VAULT).as_posix(),'title':path.stem,
                'project':'notes','status':'confirmed','kind':'real-source-snapshot','cluster':group,'content':text,'source':source})
            sources.append({'id':mid,'title':path.stem,'cluster':group,**source})
    # Eight additional REAL source notes are authority controls, never made-up facts.
    extra=[(group,path) for group,selected,guards in groups for path in guards][:8]
    assert len(extra)==8
    for number,(group,path) in enumerate(extra):
        raw=path.read_bytes(); text=raw.decode('utf-8-sig')
        mid='m-'+hashlib.sha256(('parity/'+path.relative_to(VAULT).as_posix()).encode()).hexdigest()[:16]
        (root/(mid+'.md')).write_bytes(raw)
        source={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'snapshot':str(root/(mid+'.md')),
                'isWholeNote':True,'characters':len(text),'tokens':len(tok.encode(text,add_special_tokens=False).ids)}
        project='other' if number<4 else 'notes'
        status='confirmed' if number<4 else ['candidate','superseded','inactive','deleted'][number-4]
        records.append({'id':mid,'originId':path.relative_to(VAULT).as_posix(),'title':path.stem,'project':project,
            'status':status,'kind':'real-source-authority-control','cluster':group,'content':text,'source':source})
        sources.append({'id':mid,'title':path.stem,'cluster':group,**source})
    assert len({r['id'] for r in records})==len(records) and len(records)>=32
    targets=[]
    for group,selected,guards in groups:
        eligible=[r for r in records if r['cluster']==group and r['status']=='confirmed' and r['project']=='notes' and r['source']['tokens']>1400]
        assert len(eligible)>=4, 'Not enough long-note targets; preserve prospective sampling failure'
        targets += [r['id'] for r in eligible[:4]]
    save('real-notes.json',{'records':records,'sources':sources,'inventory':inventory,'targetIds':targets,
         'textOnly':True,'attachmentsRead':False,'vaultWrites':0,'wholeNotes':True,
         'authority':'Confirmed is frozen source identity ONLY, not a confirmed user rule, preference, decision or event.',
         'methodSha256':digest(REPORTS/'method-contract.json')})
    print(json.dumps({'records':len(records),'targets':targets,'inventory':inventory,
                     'notes':[{'id':r['id'],'title':r['title'],'tokens':r['source']['tokens'],'project':r['project'],'status':r['status']} for r in records]},ensure_ascii=False))
