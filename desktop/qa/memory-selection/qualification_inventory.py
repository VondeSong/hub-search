"""Inventory-only diagnostics: no questions, queries, model calls or vault writes."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from qualification_contract import *
from passage_index import tokenizer

def inventory():
    vault=Path('D:/03_Resources/Software/Apps/Obsidian/OS');tok=tokenizer()
    old_paths=set();old_hashes=set()
    for f in (ROOT/'artifacts').glob('hbm-00-*/real-notes.json'):
        if f.parent==REPORTS:continue
        for s in json.loads(f.read_text(encoding='utf-8')).get('sources',[]):
            if s.get('path'):old_paths.add(Path(s['path']).resolve())
            if s.get('sha256'):old_hashes.add(s['sha256'])
    groups={};eligible=[]
    for group in ['Areas/结构学','Resources','Areas']:
        cmd=subprocess.run(['rg','--files',str(vault/group),'-g','*.md','-g','!AGENTS.md'],capture_output=True,check=True)
        rows=[]
        for p in cmd.stdout.decode('utf-8').splitlines():
            path=Path(p)
            if group=='Areas' and path.is_relative_to(vault/'Areas/结构学'):continue
            if any(x in ['.obsidian','.git','.trash','.basic-memory'] for x in path.parts):continue
            if path.resolve() in old_paths or not 1200<=path.stat().st_size<=60000:continue
            raw=path.read_bytes();sha=hashlib.sha256(raw).hexdigest()
            if sha in old_hashes:continue
            text=raw.decode('utf-8-sig')
            if not 1200<=len(text)<=18000 or '\x00' in text:continue
            if re.search(r'\b(?:sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.)',text):raise RuntimeError('Possible credential; stop')
            row={'path':str(path),'group':group,'sha256':sha,'tokens':len(tok.encode(text,add_special_tokens=False).ids)}
            rows.append(row);eligible.append(row)
        groups[group]={'eligible':len(rows),'long1400':sum(r['tokens']>=1400 for r in rows)}
    save('sampling-inventory.json',{'at':now(),'groups':groups,'eligible':eligible,
        'primaryAuthorSawBodies':False,'machineEligibilityRead':True,'questionsAuthored':0,'retrievalQueries':0,
        'failedSamplingContract':str(REPORTS/'new-method-contract.json'),'emptySnapshotDir':not any((WORK/'new-source-snapshots').iterdir())})
    print(json.dumps({'groups':groups,'totalEligible':len(eligible),'long1400':sum(r['tokens']>=1400 for r in eligible)}))

if __name__=='__main__':inventory()
