"""Score once, audit real protocol and source identity; no selection or parameter tuning."""
import collections
import json
from pathlib import Path
import statistics

import psutil

from applicability_policy import POLICY,validate_decisions
from latency_support import ROOT, WORK, REPORTS, MODEL, EFFORT, save, read, digest
from latency_evaluate import sources
from passage_delivery import snapshot


def stats(values):
    return {'n':len(values),'medianMs':statistics.median(values),
        'p95Ms':statistics.quantiles(values,n=100,method='inclusive')[94],
        'minMs':min(values),'maxMs':max(values)}


def stopped(pid, created):
    try:
        p=psutil.Process(pid)
        return p.create_time()!=created or not p.is_running()
    except psutil.NoSuchProcess:
        return True


if __name__=='__main__':
    method=read('method-contract.json')
    val=read('validation-contract.json')
    assert digest(Path(__file__))==read('scoring-contract.json')['reporterSha256']
    assert method['sources']==sources()
    assert digest(REPORTS/'method-contract.json')==val['methodContractSha256']
    assert digest(REPORTS/'corpus.json')==val['corpusSha256']
    assert digest(REPORTS/'validation.json')==val['validationSha256']
    evaluation=read('evaluation.json')
    assert evaluation['status']=='completed' and evaluation['mcpExitCode']==0 and not evaluation['mcpResidual']
    questions={q['id']:q for q in read('validation.json')['cases']}
    records={r['id']:r for r in read('corpus.json')['records']}
    rows=evaluation['results']
    assert len(rows)==80 and {r['id'] for r in rows}==set(questions)
    coverage=correct=false_selection=selected=selected_correct=invalid=0
    errors=[]
    model_processes=set()
    phases=collections.defaultdict(list)
    for number,row in enumerate(rows,1):
        q=questions[row['id']]
        directory=WORK/f'validation-{number:03}'
        if method['transport']=='cli':
            directory=WORK/f'validation-{number:03}-server'
        receipt=json.loads((directory/'receipt.json').read_text(encoding='utf-8'))
        assert receipt==row['modelReceipt']
        assert receipt['status']=='completed' and receipt['model']==MODEL and receipt['effort']==EFFORT
        assert receipt['toolCalls']==0 and receipt['freshEmptyHistory']
        assert receipt['ephemeral'] or method['transport']=='reuse'
        model_processes.add((receipt['pid'],receipt['createTime']))
        assert digest(directory/'input.txt')==receipt['inputSha256']
        assert digest(directory/'output.json')==receipt['outputSha256']
        prompt=(directory/'input.txt').read_text(encoding='utf-8')
        assert prompt.startswith(POLICY+'\n待核验数据：\n')
        payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
        assert set(payload)=={'project','memories','tasks'}
        task=payload['tasks'][0]
        assert len(payload['tasks'])==1 and set(task)=={'id','project','question','candidateIds'}
        assert task['id']==q['id'] and task['project']==q['project'] and task['question']==q['query']
        assert payload['memories']==row['candidates'] and len(row['candidates'])<=5
        assert task['candidateIds']==[m['id'] for m in row['candidates']]
        assert all(m['project']==q['project'] and m['status']=='confirmed' and m['text']==records[m['id']]['content'] for m in row['candidates'])
        response=json.loads((directory/'output.json').read_text(encoding='utf-8'))
        assert validate_decisions(response,[task],row['candidates'])[0]==row['checked']
        if method['transport']!='cli':
            setup=json.loads((directory/'thread-start.json').read_text(encoding='utf-8'))
            assert setup['thread']['turns']==[]
            assert setup['model']==MODEL and setup['reasoningEffort']==EFFORT
            if method['transport']=='reuse':
                assert receipt['historyRevertedAndVerified'] and not receipt['ephemeral']
                for name in ['history-before.json','history-after.json']:
                    history=json.loads((directory/name).read_text(encoding='utf-8'))
                    assert history['turns']['data']==history['items']['data']==[]
            else:
                assert setup['thread']['ephemeral'] and receipt['unsubscribe']['status']=='unsubscribed'
        for field in ['spawnToThreadStartedMs','spawnToTurnStartedMs','threadSetupMs',
                      'submitToTurnStartedMs','submitToFirstReasoningItemMs','submitToFirstAnswerDeltaMs',
                      'submitToCompletionMs','serverTurnDurationMs','historyResetMs']:
            if receipt.get(field) is not None:
                phases[field].append(receipt[field])
        gold=set(q['expected'])
        candidate_ids={m['id'] for m in row['candidates']}
        chosen=set(row['checked']['ids'])
        if gold:
            coverage+=bool(gold&candidate_ids)
            correct+=bool(gold&chosen)
            hit=bool(gold&chosen)
        else:
            false_selection+=bool(chosen)
            hit=not chosen
        selected+=len(chosen)
        selected_correct+=len(gold&chosen)
        invalid+=bool(row['checked']['invalid'])
        if not hit:
            stage='no_answer_false_selection' if not gold else 'retrieval_miss_at_5' if not gold&candidate_ids else 'applicability_error'
            errors.append({'id':q['id'],'query':q['query'],'stage':stage,'expected':q['expected'],'selected':list(chosen)})
    assert sum(bool(q['expected']) for q in questions.values())==40
    for pid,created in model_processes:
        assert stopped(pid,created)
    for file in evaluation['canonicalFiles'].values():
        assert digest(file['path'])==file['sha256']
    assert snapshot()==read('scope-contract.json')['production']
    exits=[]
    for path in WORK.glob('*/exit.json'):
        value=json.loads(path.read_text(encoding='utf-8'))
        assert stopped(value['pid'],value['createTime'])
        exits.append({'directory':path.parent.name,**value})
    for path in WORK.glob('*/process.json'):
        value=json.loads(path.read_text(encoding='utf-8'))
        assert stopped(value['pid'],value['createTime'])
    quality={'positive':40,'negative':40,'candidateCorrectAt5':coverage,'candidateRecallAt5':coverage/40,
             'selectedCorrect':correct,'selectedRecall':correct/40,'negativeFalseSelections':false_selection,
             'selectedPrecision':selected_correct/selected if selected else 0,'invalidDecisions':invalid,
             'scopeStateViolations':0}
    passed=coverage>=36 and correct>=36 and false_selection==0 and invalid==0 and quality['selectedPrecision']>=.8
    timing={field:stats([r[field] for r in rows]) for field in ['retrievalMs','modelMs','endToEndMs']}
    timing['afterFirst']=stats([r['endToEndMs'] for r in rows[1:]])
    timing['clientPhases']={k:stats(v) for k,v in phases.items() if len(v)>=2}
    timing.update({k:evaluation.get(k) for k in ['indexPrepareMs','mcpInitializeMs','persistentInitializeMs']})
    usage=[r['modelReceipt']['usage'] for r in rows]
    summary={'model':MODEL,'effort':EFFORT,'transport':method['transport'],
        'quality':quality,'qualityGatePassedOnFrozenSet':passed,'errors':errors,'timing':timing,
        'development':{k:read('development.json')[k] for k in ['mediansMs','paired','chosen','improvementDemonstrated','persistentInitializeMs']},
        'reuseDevelopment':{k:read('reuse-development.json').get(k) for k in ['status','eligible','medianMs','medianPairedSaving','fasterCases','improvementDemonstrated','chosen','limits','unavailable']},
        'profile':{'events':read('profile.json')['events'],
            'remoteConnectionEvents':read('profile.json')['remoteConnectionEvents'],
            'limits':read('profile.json')['attributionLimit'],
            'interpretation':'Four diagnostic calls. Each new independent thread established a remote WebSocket; its prewarm and actual question reused that connection within the question. Cross-question remote reuse not achieved.'},
        'cost':{'calls':80,'explicitRetries':0,'inputTokens':sum(u.get('inputTokens',u.get('input_tokens',0)) for u in usage),
                'outputTokens':sum(u.get('outputTokens',u.get('output_tokens',0)) for u in usage),
                'totalRunMs':evaluation['totalMs'],
                'usageLimit':'Counts are completed-turn receipts, not provider-request counts or billing. OTel observes additional prewarm responses; no invoice cost inferred.'},
        'attribution':'Process/setup and observed stream boundaries measured directly. Network, queue, prefill and hidden inference are not individually observable; no fabricated three-way percentage.',
        'freeze':{'corpusSha256':val['corpusSha256'],'validationSha256':val['validationSha256'],
                  'methodContractSha256':val['methodContractSha256'],'postFreezeTuning':0,'postFreezeLabelChanges':0},
        'limits':['Synthetic notes authored after method freeze by same model family; 40 positive questions cover 20 distinct new notes.',
                  'One validation execution, one supporting memory per task, no final answer generation or private-library scale.',
                  'Every question starts with verified empty history; fresh ephemeral or owned paginated history-reset transport as selected. Persistent process is not automatically remote WebSocket reuse.',
                  'No native-backend comparison, installed Hub, 20 task effects, lifecycle or 24-hour observation.'],
        'productionFilesChecked':len(read('scope-contract.json')['production']),
        'overallHbm00Qualified':False,'backendDecision':'undecided'}
    save('summary.json',summary)
    save('verification-final.json',{'status':'passed','canonicalBodiesChecked':len(records),
        'questions':80,'sourcesUnchanged':True,'labelsUnchanged':True,'modelInputsBlinded':True,
        'freshEmptyHistoryEveryQuestion':True,'allRegisteredModelParentsExited':True,
        'mcpExited':True,'productionUnchanged':True,'qualityGatePassedOnFrozenSet':passed,
        'processExits':exits,'overallHbm00Qualified':False,'backendDecision':'undecided'})
    print(json.dumps({'quality':quality,'timing':timing,'qualityGatePassedOnFrozenSet':passed,'errors':errors},ensure_ascii=False))
