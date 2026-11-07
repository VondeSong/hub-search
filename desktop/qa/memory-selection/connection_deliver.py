"""Final delivery evidence outside frozen scoring; own processes and files only."""
import json
from pathlib import Path
from connection_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,read,save,digest
from connection_transport import secret_scan
from latency_report import stopped
from passage_delivery import snapshot

if __name__=='__main__':
    assert read('verification-final.json')['status']=='passed'
    scope=read('scope-contract.json'); production=snapshot()
    assert production==scope['production']
    assert digest(PREVIOUS/'summary.json')==scope['priorSummarySha256']
    assert digest(PREVIOUS/'corpus.json')==read('corpus.json')['priorCorpusSha256']
    receipts=[]
    for path in WORK.glob('*/receipt.json'):
        receipt=json.loads(path.read_text(encoding='utf-8'))
        assert receipt['status']=='completed' and receipt['model']==MODEL and receipt['effort']==EFFORT
        assert receipt['toolCalls']==0 and receipt['explicitRetries']==0
        assert stopped(receipt['pid'],receipt['createTime'])
        receipts.append({'directory':path.parent.name,**receipt})
    # Two classifier canaries + 48 paired + 80 formal. Continuity control has its
    # own native protocol, rather than applicability receipts, for another 2 turns.
    assert len(receipts)==130
    protocol=json.loads((WORK/'continuity-no-reset/protocol.json').read_text(encoding='utf-8'))
    completed=[e for e in protocol if e['event'].get('method')=='turn/completed']
    assert len(completed)==2 and all(e['event']['params']['turn']['status']=='completed' for e in completed)
    assert any(e['event'].get('result',{}).get('model')==MODEL and e['event']['result'].get('reasoningEffort')==EFFORT for e in protocol)
    equivalence=[]
    dev=read('development-audit.json')['results']
    for ident in read('development-contract.json')['cases']:
        rows=[r for r in dev if r['id']==ident]
        assert len(rows)==4 and len({r['promptSha256'] for r in rows})==1
        assert len({r['receipt']['pid'] for r in rows})==1
        counts=[r['receipt']['usage']['inputTokens'] for r in rows]
        equivalence.append({'id':ident,'samePrompt':True,'sameProcessHomeCwd':True,
                            'inputTokens':counts,'tokenCountsEqual':len(set(counts))==1})
    scan=secret_scan(); assert not scan['credentialPersisted'] and not scan['authFileCopied']
    logical_bytes=sum(p.stat().st_size for base in [WORK,REPORTS] for p in base.rglob('*') if p.is_file())
    assert logical_bytes<=scope['budget']['newLogicalBytesMax']
    method=REPORTS/'method-contract.json'; fixture=ROOT/'qa/memory-selection/connection_new_cases.json'
    contract=REPORTS/'validation-contract.json'; first=REPORTS/'validation-001.json'
    assert method.stat().st_mtime_ns<fixture.stat().st_mtime_ns<contract.stat().st_mtime_ns<first.stat().st_mtime_ns
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'; readme=ROOT/'qa/memory-selection/README.md'
    line=next(i+1 for i,t in enumerate(plan.read_text(encoding='utf-8').splitlines()) if t.startswith('### 9.13 '))
    save('delivery-verification.json',{'status':'passed','productionUnchanged':True,'productionFilesChecked':len(production),
        'priorEvidenceUnchanged':True,'newModelTurns':132,'preflightTurns':4,'pairedTurns':48,'formalTurns':80,
        'publicRouteInferenceTurns':0,'model':MODEL,'effort':EFFORT,'explicitRetries':0,
        'receiptBackedTurns':130,'nativeContinuityProtocolBackedTurns':2,'allRegisteredParentsExited':True,
        'developmentInputEquivalence':equivalence,'credentialScan':scan,'newLogicalBytes':logical_bytes,
        'methodBeforeFactsBeforeValidationBeforeFirstResult':True,'planSectionLine':line,
        'planSha256':digest(plan),'readmeSha256':digest(readme),'backendDecision':'undecided','overallHbm00Qualified':False})
    print(json.dumps({'status':'passed','productionFiles':len(production),'modelTurns':132,
                      'logicalMiB':logical_bytes/1024**2,'planSectionLine':line}))
