"""Final delivery audit, separate from frozen question scoring."""
import json
from pathlib import Path
import statistics

from latency_support import ROOT, WORK, REPORTS, PREVIOUS, MODEL, EFFORT, save, read, digest
from latency_report import stopped
from passage_delivery import snapshot

if __name__=='__main__':
    summary=read('summary.json')
    assert read('verification-final.json')['status']=='passed'
    production=snapshot()
    assert production==read('scope-contract.json')['production']
    assert digest(PREVIOUS/'method-contract.json')==read('scope-contract.json')['oldMethodSha256']
    assert digest(PREVIOUS/'corpus.json')==read('corpus.json')['priorCorpusSha256']
    receipts=[]
    for path in WORK.glob('*/receipt.json'):
        r=json.loads(path.read_text(encoding='utf-8'))
        assert r['status']=='completed' and r['model']==MODEL and r['effort']==EFFORT
        assert r['toolCalls']==0 and r['explicitRetries']==0 and stopped(r['pid'],r['createTime'])
        receipts.append(r)
    assert len(receipts)==124 # four preflight + 36 development + four attribution + 80 validation
    equivalence=[]
    dev=read('development.json')['results']
    for ident in read('development-contract.json')['cases']:
        rows=[r for r in dev if r['id']==ident]
        assert len(rows)==3 and len({r['promptSha256'] for r in rows})==1
        counts=[r['receipt']['usage'].get('inputTokens',r['receipt']['usage'].get('input_tokens')) for r in rows]
        equivalence.append({'id':ident,'promptHashEqual':True,'inputTokens':counts,'tokenCountsEqual':len(set(counts))==1})
    logical_bytes=sum(p.stat().st_size for base in [WORK,REPORTS] for p in base.rglob('*') if p.is_file())
    assert logical_bytes<=read('scope-contract.json')['budgets']['newDiskBytesMax']
    method=REPORTS/'method-contract.json'
    fixture=ROOT/'qa/memory-selection/latency_new_cases.json'
    validation=REPORTS/'validation-contract.json'
    first=REPORTS/'validation-001.json'
    assert method.stat().st_mtime_ns<fixture.stat().st_mtime_ns<validation.stat().st_mtime_ns<first.stat().st_mtime_ns
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
    readme=ROOT/'qa/memory-selection/README.md'
    line=next(i+1 for i,text in enumerate(plan.read_text(encoding='utf-8').splitlines()) if text.startswith('### 9.12 '))
    save('delivery-verification.json',{'status':'passed','productionUnchanged':True,
        'productionFilesChecked':len(production),'oldEvidenceIdentitiesChecked':True,
        'allNewCompletedModelTurnsVerified':len(receipts),'model':MODEL,'effort':EFFORT,
        'allRegisteredModelParentsExited':True,'developmentInputEquivalence':equivalence,
        'newLogicalBytes':logical_bytes,'budgetRespected':True,'methodBeforeFactsBeforeValidationBeforeFirstResult':True,
        'planSectionLine':line,'planSha256':digest(plan),'readmeSha256':digest(readme),
        'qualityGatePassedOnFrozenSet':summary['qualityGatePassedOnFrozenSet'],
        'overallHbm00Qualified':False,'backendDecision':'undecided'})
    print(json.dumps({'status':'passed','productionFiles':len(production),'modelTurnsVerified':len(receipts),
        'logicalMiB':logical_bytes/1024**2,'planSectionLine':line,
        'equalInputTokensCases':sum(r['tokenCountsEqual'] for r in equivalence)}))
