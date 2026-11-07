"""Frozen scoring, complete protocol/source/history/credential and process audit."""
from collections import defaultdict
import json
from pathlib import Path
import statistics
from applicability_policy import POLICY,validate_decisions
from connection_support import ROOT,WORK,REPORTS,MODEL,EFFORT,digest,save,read
from connection_evaluate import sources
from connection_transport import secret_scan
from latency_report import stopped,stats
from passage_delivery import snapshot

if __name__=='__main__':
    method=read('method-contract.json'); contract=read('validation-contract.json')
    assert digest(Path(__file__))==read('scoring-contract.json')['reporterSha256']
    assert method['sources']==sources()
    assert digest(REPORTS/'method-contract.json')==contract['methodContractSha256']
    assert digest(REPORTS/'corpus.json')==contract['corpusSha256']
    assert digest(REPORTS/'validation.json')==contract['validationSha256']
    evaluation=read('evaluation.json'); rows=evaluation['results']
    assert evaluation['status']=='completed' and evaluation['mcpExitCode']==0 and not evaluation['mcpResidual']
    questions={q['id']:q for q in read('validation.json')['cases']}
    records={r['id']:r for r in read('corpus.json')['records']}
    assert len(rows)==80 and {r['id'] for r in rows}==set(questions)
    coverage=correct=false_selection=selected=selected_correct=invalid=0
    phases=defaultdict(list); errors=[]; quote_audit=[]; model_processes=set()
    for number,row in enumerate(rows,1):
        q=questions[row['id']]; directory=WORK/f'validation-{number:03}'
        receipt=json.loads((directory/'receipt.json').read_text(encoding='utf-8'))
        assert receipt==row['modelReceipt'] and receipt['status']=='completed'
        assert receipt['model']==MODEL and receipt['effort']==EFFORT and receipt['toolCalls']==0
        assert receipt['ephemeral'] and receipt['freshEmptyHistory'] and receipt['explicitRetries']==0
        assert digest(directory/'input.txt')==receipt['inputSha256'] and digest(directory/'output.json')==receipt['outputSha256']
        model_processes.add((receipt['pid'],receipt['createTime']))
        prompt=(directory/'input.txt').read_text(encoding='utf-8')
        assert prompt.startswith(POLICY+'\n待核验数据：\n')
        payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
        assert set(payload)=={'project','memories','tasks'} and len(payload['tasks'])==1
        task=payload['tasks'][0]
        assert set(task)=={'id','project','question','candidateIds'}
        assert (task['id'],task['project'],task['question'])==(q['id'],q['project'],q['query'])
        assert payload['memories']==row['candidates'] and len(row['candidates'])<=5
        assert task['candidateIds']==[m['id'] for m in row['candidates']]
        assert all(m['project']==q['project'] and m['status']=='confirmed' and m['text']==records[m['id']]['content'] for m in row['candidates'])
        response=json.loads((directory/'output.json').read_text(encoding='utf-8'))
        assert validate_decisions(response,[task],row['candidates'])[0]==row['checked']
        setup=json.loads((directory/'thread-start.json').read_text(encoding='utf-8'))
        assert setup['thread']['turns']==[] and setup['thread']['ephemeral']
        assert setup['model']==MODEL and setup['reasoningEffort']==EFFORT
        assert receipt['unsubscribe']['status']=='unsubscribed'
        for field in ['threadSetupMs','submitToTurnStartedMs','submitToFirstReasoningItemMs',
                      'submitToFirstAnswerDeltaMs','submitToCompletionMs','serverTurnDurationMs']:
            if receipt.get(field) is not None:
                phases[field].append(receipt[field])
        gold=set(q['expected']); chosen=set(row['checked']['ids']); candidate_ids={m['id'] for m in row['candidates']}
        if gold:
            coverage+=bool(gold&candidate_ids); correct+=bool(gold&chosen); hit=bool(gold&chosen)
        else:
            false_selection+=bool(chosen); hit=not chosen
        selected+=len(chosen); selected_correct+=len(gold&chosen); invalid+=bool(row['checked']['invalid'])
        if not hit:
            errors.append({'id':q['id'],'query':q['query'],'expected':q['expected'],'selected':list(chosen),
                           'stage':'no_answer_false_selection' if not gold else 'retrieval_miss_at_5' if not gold&candidate_ids else 'applicability_error'})
        if gold&chosen:
            # Supplemental evidence inclusion; never changes the frozen primary score.
            quote=json.dumps(response,ensure_ascii=False)
            quote_audit.append({'id':q['id'],'goldSupportPresentInRawOutput':q['goldSupport'] in quote})
    assert sum(bool(q['expected']) for q in questions.values())==40
    for file in evaluation['canonicalFiles'].values():
        assert digest(file['path'])==file['sha256']
    for pid,created in model_processes:
        assert stopped(pid,created)
    exits=[]
    for path in WORK.glob('*/exit.json'):
        value=json.loads(path.read_text(encoding='utf-8'))
        if 'pid' in value:
            assert stopped(value['pid'],value['createTime'])
        exits.append({'directory':path.parent.name,**value})
    for path in WORK.glob('*/process.json'):
        value=json.loads(path.read_text(encoding='utf-8'))
        if 'pid' in value:
            assert stopped(value['pid'],value['createTime'])
    assert snapshot()==read('scope-contract.json')['production']
    scan=secret_scan(); assert not scan['credentialPersisted'] and not scan['authFileCopied']
    quality={'positive':40,'negative':40,'candidateCorrectAt5':coverage,'candidateRecallAt5':coverage/40,
        'selectedCorrect':correct,'selectedRecall':correct/40,'negativeFalseSelections':false_selection,
        'selectedPrecision':selected_correct/selected if selected else 0,'invalidDecisions':invalid,'scopeStateViolations':0}
    passed=coverage>=36 and correct>=36 and false_selection==0 and invalid==0 and quality['selectedPrecision']>=.8
    timing={field:stats([r[field] for r in rows]) for field in ['retrievalMs','modelMs','endToEndMs']}
    timing['afterFirst']=stats([r['endToEndMs'] for r in rows[1:]])
    timing['clientPhases']={k:stats(v) for k,v in phases.items() if len(v)>1}
    timing.update({k:evaluation[k] for k in ['indexPrepareMs','mcpInitializeMs','persistentInitializeMs']})
    usage=[r['modelReceipt']['usage'] for r in rows]
    slow=sorted(enumerate(rows,1),key=lambda t:-t[1]['endToEndMs'])[:3]
    summary={'model':MODEL,'effort':EFFORT,'tier':'default','transport':'persistent',
        'actualCrossQuestionRemoteReuse':False,'quality':quality,'qualityGatePassedOnFrozenSet':passed,
        'errors':errors,'timing':timing,'slowest':[{'number':n,'id':r['id'],'endToEndMs':r['endToEndMs'],
                                                'receipt':r['modelReceipt']} for n,r in slow],
        'development':{k:read('development-audit.json')[k] for k in ['observations','timing','nativeConnectCounts','samePid',
            'exactOutcomes','pairedMedianSaving','fasterPairs','candidateEligible','chosen','timingConfound',
            'resetConnectEventsOutsideOwnCallWindow']},
        'tailAudit':read('prior-phases.json'),
        'publicRoute':{'websocketHandshakeStatus':401,'modelsGetStatus':read('public-access.json')['status'],
                       'inferenceTurns':0,'eligible':False,'privateEndpointOrPaidKeyFallback':False},
        'cost':{'formalTurns':80,'explicitRetries':0,'inputTokens':sum(u['inputTokens'] for u in usage),
                'outputTokens':sum(u['outputTokens'] for u in usage),'totalRunMs':evaluation['totalMs'],
                'limits':'Completed-turn usage excludes prewarm and is not an invoice or provider-request count.'},
        'freeze':{'corpusSha256':contract['corpusSha256'],'validationSha256':contract['validationSha256'],
                  'methodContractSha256':contract['methodContractSha256'],'postFreezeTuning':0,'postFreezeLabelChanges':0},
        'shape':read('fixture-build.json'),'credentialScan':scan,
        'limits':['Same-family synthetic notes and evaluation, not independent human labels or private-library scale.',
                  '40 positive questions cover 20 new notes; one supporting memory and no final answer generation.',
                  'Transport candidate failed real remote reuse; fresh holdout tests the retained baseline, not an optimized connection.',
                  'No server telemetry separates network/queue/prefill/hidden inference; do not call request wait pure inference.',
                  'Native backend comparison, real task effects, lifecycle, installed runtime and 24-hour observation remain open.'],
        'productionFilesChecked':len(read('scope-contract.json')['production']),
        'overallHbm00Qualified':False,'backendDecision':'undecided'}
    save('summary.json',summary)
    save('supplemental-quote-audit.json',{'rows':quote_audit,'counts':{'goldFactsPresent':sum(r['goldSupportPresentInRawOutput'] for r in quote_audit),
                                                                    'correctPositive':len(quote_audit)},
         'meaning':'String inclusion in raw response only; primary quote validation is exact canonical-body validation. No label or score change.'})
    save('verification-final.json',{'status':'passed','canonicalBodiesChecked':len(records),'questions':80,
         'sourcesUnchanged':True,'labelsUnchanged':True,'inputsBlinded':True,'emptyHistoryVerified':True,
         'productionUnchanged':True,'credentialScan':scan,'allRegisteredParentsExited':True,'mcpExited':True,
         'qualityGatePassedOnFrozenSet':passed,'processExits':exits,'overallHbm00Qualified':False,'backendDecision':'undecided'})
    print(json.dumps({'quality':quality,'timing':timing,'passed':passed,'errors':errors},ensure_ascii=False))
