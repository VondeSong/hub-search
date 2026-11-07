"""Read-only real-note snapshots after method freeze; never writes into the vault."""
import hashlib
import json
from pathlib import Path
import re
from accounting_support import WORK,REPORTS,read,save,digest
from passage_index import tokenizer

if __name__=='__main__':
    read('method-contract.json')
    vault=Path('D:/03_Resources/Software/Apps/Obsidian/OS')
    folder=vault/'Resources/笔记管理'
    paths=sorted([p for p in folder.rglob('*.md') if p.name not in ['MOC.md','00 笔记管理 - MOC.md','AGENTS.md'] and p.stat().st_size>=350])
    if len(paths)<10:
        extra=sorted(p for p in (vault/'Areas/思维与学习').rglob('*.md') if 'MOC' not in p.name and p.name!='AGENTS.md' and p.stat().st_size>=350)
        paths+=extra[:10-len(paths)]
    if len(paths)<10:
        # Metadata-only fallback before reading content or authoring questions.
        extra=sorted(p for p in (vault/'Resources/任务管理').rglob('*.md') if p.name!='AGENTS.md' and p.stat().st_size>=350)
        paths+=extra[:10-len(paths)]
    if len(paths)<10:
        paths.append(folder/'MOC.md')  # Historical design source, never current authority.
    assert len(paths)>=10
    paths=paths[:10]
    root=WORK/'real-note-snapshots'; root.mkdir(exist_ok=False)
    tok=tokenizer(); records=[]; sources=[]
    for i,path in enumerate(paths,1):
        assert path.resolve().is_relative_to(vault.resolve())
        raw=path.read_bytes(); text=raw.decode('utf-8-sig')
        if re.search(r'\b(?:sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.)',text):
            raise RuntimeError('Possible credential in candidate note; stop source collection, do not export')
        encoded=tok.encode(text,add_special_tokens=False)
        end=len(text)
        if len(encoded.ids)>2048:
            end=encoded.offsets[2047][1]
            paragraph=text.rfind('\n\n',0,end)
            if paragraph>0:
                end=paragraph
        excerpt=text[:end]
        assert len(excerpt.strip())>40
        origin=f'real-{i:02}'
        (root/f'{origin}-original.md').write_bytes(raw)
        (root/f'{origin}-excerpt.md').write_text(excerpt,encoding='utf-8')
        source={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'excerptStart':0,'excerptEnd':end,
                'offsetUnit':'Unicode characters after UTF-8-sig decode, original newline bytes retained',
                'isWholeNote':end==len(text),'sourceTokens':len(encoded.ids),'excerptTokens':len(tok.encode(excerpt,add_special_tokens=False).ids)}
        sources.append({'origin':origin,'title':path.stem,**source})
        records.append({'origin':origin,'title':'真实笔记快照 / '+path.stem,'project':'real-notes','status':'confirmed',
            'kind':'real-note','content':'以下是来源笔记的只读文本快照，仅表示来源记载，不构成用户偏好或已经执行的决定。\n\n'+excerpt,
            'source':source})
    save('real-notes.json',{'records':records,'sources':sources,'methodBeforeSelection':True,
        'vaultWrites':0,'attachmentsRead':False,'scope':'Text-only questions supported by explicit text; no claim to full-vault or image/PDF coverage.',
        'authority':'confirmed denotes frozen source identity in this isolated test only; no production memory confirmation or permission change.'})
    print(json.dumps({'notes':len(records),'sources':[{'origin':r['origin'],'title':r['title'],'tokens':r['excerptTokens'],'whole':r['isWholeNote']} for r in sources]},ensure_ascii=False))
