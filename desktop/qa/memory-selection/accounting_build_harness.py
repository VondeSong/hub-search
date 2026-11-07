"""Create this round's explicit sources from immutable previous QA, before freeze."""
from pathlib import Path
from accounting_support import save

BASE=Path(__file__).parent
def write(name,text):
    with (BASE/name).open('x',encoding='utf-8') as file:
        file.write(text)

if __name__=='__main__':
    source=(BASE/'connection_evaluate.py').read_text(encoding='utf-8')
    source=source.replace('from connection_support import','from accounting_support import').replace('from connection_transport import Wire','from accounting_transport import Wire,ledger')
    source=source.replace("names=['connection_support.py','connection_transport.py','connection_evaluate.py',", "names=['accounting_support.py','accounting_transport.py','accounting_evaluate.py','connection_transport.py',")
    begin=source.index('def freeze_method():'); end=source.index('\ndef evaluate():',begin)
    source=source[:begin]+'''def freeze_method():
    dev=read('development-audit.json')
    assert dev['status']=='completed' and dev['turns']==48 and dev['chosen']=='persistent-ws'
    save('method-contract.json',{'frozenAt':datetime.now(timezone.utc).isoformat(),'model':MODEL,'effort':EFFORT,'tier':'default',
        'transport':'persistent-ws','actualCrossQuestionRemoteReuse':False,
        'selectionEvidenceSha256':digest(REPORTS/'development-audit.json'),
        'retrieval':'Unchanged token passages/vector + Chinese FTS5/jieba RRF60, raw80 parent20 final5. No reranker.',
        'policy':POLICY,'schema':SCHEMA,'sources':sources(),'formalOtelExporter':True,
        'freshEmptyHistoryEveryQuestion':True,'ephemeral':True,'explicitRetries':0,
        'validationExecutionsMax':1,'postFreezeTuningAllowed':False,
        'gates':read('scope-contract.json')['holdout']['qualityGates'],
        'newDataPlan':{'previousRecords':208,'realNotes':10,'realPositiveQuestions':20,'newSyntheticNotes':10,
            'syntheticPositiveQuestions':20,'stateGuards':8,'nearSubjectDistractors':30,'totalRecords':266,
            'negative':100,'positive':40,'realExtraction':'Full note when <=2048 cached BGE tokens, else one continuous initial <=2048-token section; preserve exact source offsets and original hash. No query/rank-driven extraction.',
            'sourceProjects':['parts','reading','hub','real-notes'],'knownFailureTypes':['long-tail facts','near IDs and versions','weak lexical wording','conditional scopes'],
            'newFailureTypes':['quote vs instruction','source statement vs actual user event','negated/default scope vs exception','partial numeric identity']},
        'candidatePresentation':'Keep membership and original retrieval ranks; rotate up to five candidates by opaque question-ID hash modulo count, without reading labels. Report presentation position separately from retrieval rank.',
        'negativeUpperBound':'Zero/100 gives one-sided 95% binomial bound 1-0.05**0.01 (~2.95%) under IID assumption; correlated constructed cases do not establish population error.',
        'stop':'This is the last latency/accounting round. Next work is remaining backend gates, no further latency tuning.'})
    print('Method frozen before new note selection and new questions.')

''' +source[end:]
    source=source.replace("corpus=read('corpus.json'); questions=read('validation.json')['cases']", "corpus=read('corpus.json'); questions=read('validation.json')['cases']; assert len(questions)==140")
    source=source.replace("wire=Wire(WORK/'validation-server',telemetry_enabled=False)","model_started=time.perf_counter()\n        wire=Wire(WORK/'validation-server',http=False)")
    source=source.replace("candidates=index.candidates(found['fused'],q['project'])", "candidates=index.candidates(found['fused'],q['project'])\n            if candidates:\n                rotate=int(q['id'][2:10],16)%len(candidates)\n                candidates=candidates[rotate:]+candidates[:rotate]")
    source=source.replace("response,receipt=wire.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')", "model_start_ns=time.time_ns()\n            response,receipt=wire.app_call(prompt,SCHEMA,WORK/f'validation-{number:03}')\n            model_end_ns=time.time_ns()")
    source=source.replace("row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,", "row={'id':q['id'],'project':q['project'],'retrieval':found,'candidates':candidates,\n                 'modelStartUnixNs':model_start_ns,'modelEndUnixNs':model_end_ns,")
    source=source.replace("'completed':number,'total':80", "'completed':number,'total':140")
    source=source.replace("if wire:\n            wire.close()", "if wire:\n            if result['status']=='completed':\n                result['modelDrain']=wire.drain(2*len(result['results']))\n            wire.close()\n            result['modelBatchWallMs']=(time.perf_counter()-model_started)*1000\n            if result['status']=='completed':\n                result['fullModelLedger']=ledger(wire.telemetry.rows,[{'id':r['id'],'startUnixNs':r['modelStartUnixNs'],'endUnixNs':r['modelEndUnixNs'],'receipt':r['modelReceipt']} for r in result['results']])")
    write('accounting_evaluate.py',source)

    source=(BASE/'connection_fixture.py').read_text(encoding='utf-8')
    source=source.replace('from connection_support import','from accounting_support import').replace('connection-holdout/','accounting-holdout/').replace('connection_new_cases.json','accounting_new_cases.json').replace('connection_report.py','accounting_report.py')
    source=source.replace("'source':'New fictional record after connection method freeze; no personal notes.'", "'source':r.get('source','New fictional record after accounting method freeze.'),\n                        'kind':r.get('kind','synthetic')")
    source=source.replace("assert len(records)==208 and len(cases)==80", "assert len(records)==266 and len(cases)==140")
    source=source.replace("'hbm-00-latency-20261018']", "'hbm-00-latency-20261018','hbm-00-connection-20261018']")
    source=source.replace("==80\n", "==140\n").replace("'questions':80,'positive':40,'negative':40", "'questions':140,'positive':40,'negative':100")
    source=source.replace("'projects':previous['projects']", "'projects':{**previous['projects'],'real-notes':'OS真实笔记只读快照'}")
    source=source.replace("random.Random(2026101811)","random.Random(2026101821)").replace("random.Random(2026101812)","random.Random(2026101822)")
    write('accounting_fixture.py',source)

    source=(BASE/'connection_report.py').read_text(encoding='utf-8')
    source=source.replace('from connection_support import','from accounting_support import').replace('from connection_evaluate import sources','from accounting_evaluate import sources').replace('from connection_transport import secret_scan','from accounting_transport import secret_scan')
    source=source.replace('len(rows)==80','len(rows)==140').replace("'negative':40", "'negative':100").replace("'formalTurns':80", "'formalTurns':140").replace("'questions':80", "'questions':140")
    begin=source.index("        'development':"); end=source.index("        'freeze':",begin)
    source=source[:begin]+'''        'development':read('development-audit.json'),
        'publicAdmission':read('public-admission-v2.json'),
        'cost':{'formalTurns':140,'explicitRetries':0,'fullResponseRequests':evaluation['fullModelLedger']['responseRequests'],
            'prewarmRequests':evaluation['fullModelLedger']['prewarmRequests'],
            'unusedFinalPrewarmRequests':evaluation['fullModelLedger']['unusedFinalPrewarmRequests'],
            'inputTokensIncludingPrewarm':evaluation['fullModelLedger']['totalInputTokens'],
            'outputTokensIncludingPrewarm':evaluation['fullModelLedger']['totalOutputTokens'],
            'cachedInputTokensIncludingPrewarm':evaluation['fullModelLedger']['cachedInputTokens'],
            'totalTokensIncludingPrewarm':evaluation['fullModelLedger']['totalTokens'],
            'allNetworkRequestCount':evaluation['fullModelLedger']['allNetworkRequestCount'],
            'modelBatchWallMs':evaluation['modelBatchWallMs'],'totalRunMs':evaluation['totalMs'],
            'limits':'All native response/prewarm usage included; control requests have no generation tokens. Token workload is not a provider invoice.'},
''' +source[end:]
    source=source.replace("'Same-family synthetic notes and evaluation, not independent human labels or private-library scale.'", "'Same-family primary author and Codex judge, not independent labels; 20 positive questions use 10 read-only real-note snapshots, remaining 20 are synthetic.'")
    source=source.replace("'40 positive questions cover 20 new notes; one supporting memory and no final answer generation.'", "'40 positive questions cover 20 new records; one supporting memory and no final answer generation. 100 constructed negative cases are correlated.'")
    source=source.replace("    save('summary.json',summary)", "    summary['negativeOneSided95UpperBoundAssumingIID']=1-.05**(1/100)\n    summary['negativeBoundLimit']='Constructed correlated cases are not an IID population sample; zero observed errors is not proof of zero population error.'\n    ranks=[]\n    for row in rows:\n        q=questions[row['id']]\n        if q['expected']:\n            gold=q['expected'][0]\n            ranks.append({'id':q['id'],'kind':q['category'],'retrievalRank':row['retrieval']['fused'].index(gold)+1 if gold in row['retrieval']['fused'] else None,'presentationPosition':next((i+1 for i,m in enumerate(row['candidates']) if m['id']==gold),None)})\n    summary['positiveRanks']=ranks\n    summary['latencyOptimizationTrack']='closed_after_this_round'\n    save('summary.json',summary)")
    write('accounting_report.py',source)
    save('harness-generation.json',{'sources':['accounting_evaluate.py','accounting_fixture.py','accounting_report.py'],
         'previousSourcesUnchanged':True,'createdBeforeMethodAndDataFreeze':True})
    print('New explicit harness sources created; old QA sources unchanged.')
