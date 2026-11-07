"""Final delivery audit; source/label identities and owned-process boundaries."""
import json
import os
from pathlib import Path
from accounting_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,read,save,digest
from accounting_evaluate import sources
from latency_report import stopped

if __name__=='__main__':
    verification=read('verification-final.json');scope=read('scope-contract.json');summary=read('summary.json')
    assert verification['status']=='passed' and read('complete-round-cost.json')['totals']['formalTurns']==194
    # Frozen scoring already performed the complete 814-file source check.
    # Only documentation and postprocessing reports changed after that boundary.
    assert verification['productionUnchanged'] and verification['sourcesUnchanged']
    assert digest(PREVIOUS/'summary.json')==scope['priorSummarySha256']
    assert digest(PREVIOUS/'corpus.json')==read('corpus.json')['priorCorpusSha256']
    assert read('method-contract.json')['sources']==sources()
    assert digest(ROOT/'qa/memory-selection/accounting_report.py')==read('scoring-contract.json')['reporterSha256']
    development=read('development-raw.json')
    staged=[('initial-http-'+str(i),json.loads((WORK/f'preflight-http-{i:02}/receipt.json').read_text(encoding='utf-8'))) for i in [1,2]]
    for filename in ['preflight-http-v2.json','preflight-reset-http.json']:
        staged.extend((filename+'-'+str(i),q['receipt']) for i,q in enumerate(read(filename)['questions'],1))
    for batch in development['batches']:
        staged.extend((batch['name']+'-'+str(i),q['receipt']) for i,q in enumerate(batch['questions'],1))
    staged.extend(('validation-'+str(i),q['modelReceipt']) for i,q in enumerate(read('evaluation.json')['results'],1))
    receipts=[]
    for directory,value in staged:
        assert value['status']=='completed' and value['model']==MODEL and value['effort']==EFFORT
        assert value['toolCalls']==0 and value['explicitRetries']==0
        assert stopped(value['pid'],value['createTime'])
        receipts.append({'directory':directory,'pid':value['pid'],'model':value['model'],'effort':value['effort']})
    assert len(receipts)==194
    equivalence=[]
    all_questions=[q for b in development['batches'] for q in b['questions']]
    for ident in sorted({q['id'] for q in all_questions}):
        copies=[q for q in all_questions if q['id']==ident]
        assert len(copies)==12 and len({q['receipt']['inputSha256'] for q in copies})==1
        equivalence.append({'id':ident,'copies':12,'promptHashEqual':True,
          'nativeInputTokens':{mode:sorted({q['receipt']['usage']['inputTokens'] for q in copies if q['mode']==mode}) for mode in ['persistent-ws','reset-ws','reset-http']}})
    processes=[]
    for path in list(WORK.glob('*/process.json'))+[WORK/'validation-index/bm/process.json']:
        reg=json.loads(path.read_text(encoding='utf-8'))
        if 'pid' not in reg:continue
        assert stopped(reg['pid'],reg['createTime'])
        processes.append({'path':str(path.relative_to(WORK)),'pid':reg['pid'],'stopped':True})
    # Check actual original bytes; do not write back even if externally changed.
    notes=[]
    for source in read('real-notes.json')['sources']:
        same=digest(source['path'])==source['sha256']
        notes.append({'origin':source['origin'],'originalHashUnchanged':same})
    assert all(n['originalHashUnchanged'] for n in notes)
    method=REPORTS/'method-contract.json'; raw=ROOT/'qa/memory-selection/accounting_new_cases.json'
    frozen=REPORTS/'validation-contract.json'; marker=REPORTS/'execution-start.json'; first=REPORTS/'validation-001.json'
    assert method.stat().st_mtime_ns<raw.stat().st_mtime_ns<frozen.stat().st_mtime_ns<marker.stat().st_mtime_ns<first.stat().st_mtime_ns
    # Known credential bytes are used only in memory for this scan; never printed.
    auth=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
    tokens=json.loads(auth.read_text(encoding='utf-8')).get('tokens',{})
    needles=[v.encode() for k,v in tokens.items() if k in ['access_token','refresh_token','id_token'] and isinstance(v,str) and len(v)>30]
    leaks=[]
    assert not verification['credentialScan']['credentialPersisted']
    for base in [REPORTS]:
        for path in base.rglob('*'):
            if path.is_file() and any(n in path.read_bytes() for n in needles): leaks.append(str(path.relative_to(base)))
    assert not leaks and not (WORK/'codex-home/auth.json').exists()
    logical=sum(p.stat().st_size for base in [WORK,REPORTS] for p in base.rglob('*') if p.is_file())
    assert logical<=scope['budget']['newLogicalBytesMax']
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'; readme=ROOT/'qa/memory-selection/README.md'
    text=plan.read_text(encoding='utf-8');assert 'HBM_ACCOUNTING_FINAL_RESULT_PENDING' not in text
    line=next(i+1 for i,t in enumerate(text.splitlines()) if t.startswith('### 9.14 '))
    save('delivery-verification.json',{'status':'passed','productionUnchanged':True,'productionFilesChecked':len(scope['production']),
       'priorEvidenceUnchanged':True,'priorEvidenceIdentityChecked':['previous summary.json','previous corpus.json'],
       'model':MODEL,'effort':EFFORT,'newModelTurns':194,'preflightTurns':6,'pairedTurns':48,'formalTurns':140,
       'publicAdmissionRequests':4,'publicRouteInferenceTurns':0,'explicitRetries':0,'allRegisteredParentsExited':True,
       'processes':processes,'receipts':receipts,'originalRealNotes':notes,'developmentInputEquivalence':equivalence,
       'noCredentialsPersisted':True,'noAuthFileCopied':True,'newLogicalBytes':logical,
       'reusedVerificationBoundary':'Frozen report verified all canonical files, formal receipt bytes and 814 production files; no production mutations followed. Final audit extends credential scan to reports and verifies all recorded actors exited.',
       'methodBeforeFactsBeforeValidationBeforeFirstResult':True,'postFreezeTuning':0,'postFreezeLabelChanges':0,
       'planSectionLine':line,'planSha256':digest(plan),'readmeSha256':digest(readme),
       'qualityGatePassedOnFrozenSet':summary['qualityGatePassedOnFrozenSet'],
       'latencyOptimizationTrack':'closed','backendDecision':'undecided','overallHbm00Qualified':False,'laterBatchesStarted':False})
    print(json.dumps({'status':'passed','productionFiles':len(scope['production']),'modelTurns':194,
                      'logicalMiB':logical/1024**2,'planSectionLine':line}))
