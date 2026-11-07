"""Post-run immutable-input/provenance and complete known-cost audit.

This does not change labels, candidate rankings, judgments or frozen scoring.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import psutil

from qualification_contract import *
from qualification_run import code_identity, method_name, POLICY, validate_decisions
from qualification_evidence import GAP
from grounding_score import stats
from qualification_accounting import configure_transport


def audit():
    evaluation=read('evaluation.json')
    assert evaluation.get('finishedAt')
    frozen=read('validation-contract.json')
    identity={
        'methodSourcesUnchanged':frozen['sources']==code_identity(),
        'methodContractUnchanged':frozen['methodSha256']==digest(REPORTS/method_name()),
        'corpusUnchanged':frozen['corpusSha256']==digest(REPORTS/'corpus.json'),
        'labelsUnchanged':frozen['validationSha256']==digest(REPORTS/'validation.json'),
    }
    records={r['id']:r for r in read('corpus.json')['records']}
    cases={q['id']:q for q in read('validation.json')['cases']}
    spans=0
    for i,row in enumerate(evaluation['rows'],1):
        receipt=row['receipt']
        assert receipt['status']=='completed' and receipt['model']==MODEL and receipt['effort']==EFFORT
        assert receipt['toolCalls']==0 and receipt['freshEmptyHistory'] and receipt['ephemeral']
        directory=WORK/f'new-call-{i:03}'
        configured=json.loads((directory/'thread-start.json').read_text(encoding='utf-8'))
        assert configured['model']==MODEL and configured['reasoningEffort']==EFFORT
        assert receipt['inputSha256']==digest(directory/'input.txt') and receipt['outputSha256']==digest(directory/'output.json')
        assert evaluation['modelCalls'][i-1]['questionId']==row['id']
        q=cases[row['id']]
        task={'id':q['id'],'project':q['project'],'question':q['query'],
              'candidateIds':[m['id'] for m in row['retrieval']['candidates']]}
        prompt=POLICY+'\n待核验数据：\n'+json.dumps({'memories':row['retrieval']['candidates'],'tasks':[task]},ensure_ascii=False,separators=(',',':'))
        assert (directory/'input.txt').read_text(encoding='utf-8')==prompt
        answer=json.loads((directory/'output.json').read_text(encoding='utf-8'))
        assert validate_decisions(answer,[task],row['retrieval']['candidates'])[0]==row['checked']
        candidates={c['id']:c for c in row['retrieval']['candidates']}
        for origin in row['retrieval']['provenance']:
            body=records[origin['id']]['content']
            assert hashlib.sha256(body.encode()).hexdigest()==origin['bodySha256']
            assert candidates[origin['id']]['text']==GAP.join(body[s['start']:s['end']] for s in origin['spans'])
            for span in origin['spans']:
                assert hashlib.sha256(body[span['start']:span['end']].encode()).hexdigest()==span['sha256']
                spans+=1
        assert row['retrieval']['materialBudget']['estimatedTextTokens']<=1500
    source_audit=[]
    for source in read('real-notes.json')['sources']:
        source_audit.append({'id':source['id'],'snapshotUnchanged':digest(source['snapshot'])==source['sha256'],
            'originalUnchanged':Path(source['path']).is_file() and digest(source['path'])==source['sha256']})
    assert all(identity.values()) and all(s['snapshotUnchanged'] for s in source_audit)
    process=json.loads((WORK/'new-quality-server/process.json').read_text(encoding='utf-8'))
    residual=False
    try:
        actor=psutil.Process(process['pid'])
        residual=abs(actor.create_time()-process['createTime'])<1
    except psutil.NoSuchProcess:pass
    assert not residual, 'Quality producer has not exited'
    native=configure_transport()
    work_scan=native.secret_scan()
    old_root=native.ct.WORK
    try:
        native.ct.WORK=REPORTS
        report_scan=native.secret_scan()
    finally:native.ct.WORK=old_root
    assert not work_scan['credentialPersisted'] and not report_scan['credentialPersisted']
    entries=[]
    olddev=read('development-v2-failed-closure-report.json')
    entries.append({'name':'development-v2','questions':len(olddev['calls']),'ledger':olddev['knownCosts'],
                    'complete':False,'questionTimesMs':[c['receipt']['durationMs'] for c in olddev['calls']]})
    for tag in ['development-v3','development-v4']:
        dev=read(tag+'-model.json');closure=dev['closure']
        entries.append({'name':tag,'questions':len(dev['calls']),'ledger':closure['ledger'],
                        'complete':closure['costGatePassed'], 'questionTimesMs':[c['receipt']['durationMs'] for c in dev['calls']]})
    closure=evaluation.get('closure',{})
    entries.append({'name':'new-formal','questions':len(evaluation['modelCalls']),'ledger':closure.get('ledger',{}),
                    'complete':closure.get('costGatePassed',False),
                    'questionTimesMs':[c['receipt']['durationMs'] for c in evaluation['modelCalls']]})
    keys=['responseRequests','prewarmRequests','unusedFinalPrewarmRequests','totalInputTokens','totalOutputTokens',
          'cachedInputTokens','totalTokens','allNetworkRequestCount']
    components=[]
    for e in entries:
        ledger=e['ledger']
        components.append({'name':e['name'],'questionCalls':e['questions'],'costComplete':e['complete'],
            **{k:ledger.get(k) for k in keys},
            'observedSends':ledger.get('observedSendRequests',ledger.get('responseRequests')),
            'unknownSendCosts':ledger.get('unmatchedObservedSends',[]),
            'questionMs':stats(e['questionTimesMs'])})
    totals={k:sum(c[k] or 0 for c in components) for k in keys}
    totals.update(questionCalls=sum(c['questionCalls'] for c in components),
                  observedSends=sum(c['observedSends'] or 0 for c in components),
                  unknownSendCosts=sum(len(c['unknownSendCosts']) for c in components),
                  costComplete=all(c['costComplete'] for c in components))
    failure_counts=Counter();failures=[]
    if (REPORTS/'scored-results.json').exists():
        for d in read('scored-results.json')['details']:
            if d['checked']['invalid']:
                category='protocol_or_accounting'
            elif d['positive'] and not d['selectedCorrect']:
                category=('retrieval_miss20' if d['initialRank'] is None else
                          'ranking_outside5' if not d['candidateHit'] else
                          'evidence_crop_or_budget' if not d['evidenceDelivered'] else 'model_judgement_or_label_review')
            elif not d['positive'] and d['checked']['ids']:
                category='negative_false_selection_or_label_review'
            else: continue
            failure_counts[category]+=1
            failures.append({'id':d['id'],'automaticCategory':category,'labelManuallyReviewed':False})
    save('delivery-audit.json',{'at':now(),'identity':identity,'sourceAudit':source_audit,'verifiedExactSpans':spans,
        'qualityProducerResidual':residual,'credentialScans':{'work':work_scan,'reports':report_scan},
        'completedQuestions':len(evaluation['rows']),'planned':140,
        'actualInputsOutputsAndEffectiveModelVerified':True,
        'model':MODEL,'effort':EFFORT,'costComponents':components,'knownCostTotals':totals,
        'formalWholeBatchWallMs':evaluation['totalWallMs'],
        'perQuestionMeasuredLocalPlusModelMs':stats([r['retrieval']['retrievalMs']+r['receipt']['durationMs'] for r in evaluation['rows']]),
        'costMeaning':'All observed warmups, unused final warmups and sends included. Token totals cover known usage only; missing-send cost, primary-agent usage and local embedding tokens remain unknown, not zero. Not an invoice.',
        'latencyMeaning':'Sequential questions with retrieval time between turns; no registered idle-gap/continuous transport optimization in this round. Full batch includes index preparation and closing. Paired local+model sums are measured component sums, not a fresh installed-product/UI end-to-end wall timer; lexical timings came from the earlier real Hub fixture batch.',
        'automaticFailureCounts':dict(failure_counts),'failureReviewQueue':failures,
        'gradingMeaning':'Frozen minimum fact-core source/quote selection; not complete natural-language answer accuracy. Same-family annotation, clustered questions, no independent population guarantee.',
        'exactModelMaterialBudgetVerified':False,'backendSelected':False,'laterBatchesStarted':False})
    print(json.dumps({'identity':identity,'questions':len(evaluation['rows']), 'spans':spans,'cost':totals,
                      'failureCounts':dict(failure_counts)},ensure_ascii=False))


if __name__=='__main__':audit()
