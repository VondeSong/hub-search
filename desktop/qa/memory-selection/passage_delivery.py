"""Read-only production source snapshots, separate from benchmark scoring."""
import argparse
import json
from pathlib import Path

from passage_support import ROOT,REPORTS,digest,save,read


def snapshot():
    paths=[]
    for name in ['src','src-tauri/src','src-tauri/resources']:
        root=ROOT/name
        if root.exists():
            paths.extend(p for p in root.rglob('*') if p.is_file())
    paths.extend(ROOT/name for name in ['package.json','package-lock.json','src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock','src-tauri/tauri.conf.json'] if (ROOT/name).is_file())
    return {p.relative_to(ROOT).as_posix():digest(p) for p in sorted(paths)}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['before','after'])
    args=parser.parse_args()
    current=snapshot()
    if args.phase=='before':
        previous=json.loads((ROOT/'artifacts/hbm-00-independent-20261018/execution-contract.json').read_text(encoding='utf-8'))['production']
        save('production-before.json',{'files':current,'sameAsPriorRound':current==previous,
                                       'snapshotSourceSha256':digest(Path(__file__))})
        print(json.dumps({'files':len(current),'sameAsPriorRound':current==previous}))
    else:
        before=read('production-before.json')
        assert before['files']==current
        summary=read('summary.json')
        assert read('verification-final.json')['status']=='passed'
        plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
        text=plan.read_text(encoding='utf-8')
        line=next(i+1 for i,t in enumerate(text.splitlines()) if t.startswith('### 9.11 '))
        save('delivery-verification.json',{'status':'passed','productionFilesChecked':len(current),
            'productionUnchanged':True,'planSectionLine':line,'planSha256':digest(plan),
            'readmeSha256':digest(ROOT/'qa/memory-selection/README.md'),
            'qualityGatePassedOnFrozenSet':summary['qualityGatePassedOnFrozenSet'],
            'overallHbm00Qualified':False,'backendDecision':'undecided'})
        print(json.dumps({'status':'passed','productionFilesChecked':len(current),'planSectionLine':line}))
