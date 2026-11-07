"""Immutable new-set scoring; no parameter selection or retries here."""
import collections
import json
from pathlib import Path
import statistics

import psutil

from applicability_policy import POLICY,validate_decisions
from passage_support import ROOT,WORK,REPORTS,PREVIOUS,MODEL,EFFORT,read,save,digest
from passage_run import sources


def stats(values):
    return {'n':len(values),'medianMs':statistics.median(values),
            'p95Ms':statistics.quantiles(values,n=100,method='inclusive')[94],
            'minMs':min(values),'maxMs':max(values)}


def no_process(receipt):
    try:
        p=psutil.Process(receipt['pid'])
        return p.create_time()!=receipt['createTime'] or not p.is_running()
    except psutil.NoSuchProcess:
        return True


if __name__=='__main__':
    fixed=read('method-contract.json')
    val=read('validation-contract.json')
    scoring=read('scoring-contract.json')
    assert digest(Path(__file__))==scoring['reporterSha256']
    assert fixed['sources']==sources()
    assert digest(REPORTS/'method-contract.json')==val['methodContractSha256']
    assert digest(REPORTS/'corpus.json')==val['corpusSha256']
    assert digest(REPORTS/'validation.json')==val['validationSha256']
    evaluation=read('evaluation.json')
    assert evaluation['status']=='completed' and not evaluation['residual'] and evaluation['mcpExitCode']==0
    rows=evaluation['results']
    questions={q['id']:q for q in read('validation.json')['cases']}
    records={r['id']:r for r in read('corpus.json')['records']}
    assert len(rows)==len(questions)==80 and {r['id'] for r in rows}==set(questions)
    correct=negative_false=selected=selected_correct=invalid=0
    coverage=0
    errors=[]
    category=collections.defaultdict(lambda:{'n':0,'correct':0})
    for number,row in enumerate(rows,1):
        q=questions[row['id']]
        directory=WORK/f'validation-{number:03}'
        receipt=json.loads((directory/'receipt.json').read_text(encoding='utf-8'))
        assert receipt['status']=='completed' and receipt['exitCode']==0 and receipt['toolCalls']==0
        assert receipt['requestedModel']==MODEL and receipt['reasoning']==EFFORT
        assert receipt['instructionsMode']==('compact classifier base' if fixed['compactBase'] else 'original Codex base')
        assert no_process(receipt)
        assert digest(directory/'input.txt')==receipt['inputSha256']
        assert digest(directory/'output.json')==receipt['outputSha256']
        prompt=(directory/'input.txt').read_text(encoding='utf-8')
        assert prompt.startswith(POLICY+'\n待核验数据：\n')
        payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
        assert set(payload)=={'project','memories','tasks'}
        assert len(payload['tasks'])==1
        task=payload['tasks'][0]
        assert set(task)=={'id','project','question','candidateIds'}
        assert task['id']==q['id'] and task['project']==q['project'] and task['question']==q['query']
        assert task['candidateIds']==[m['id'] for m in row['candidates']]
        assert payload['memories']==row['candidates'] and len(row['candidates'])<=5
        assert all(m['project']==q['project'] and m['status']=='confirmed' and m['text']==records[m['id']]['content'] for m in row['candidates'])
        response=json.loads((directory/'output.json').read_text(encoding='utf-8'))
        assert validate_decisions(response,[task],payload['memories'])[0]==row['checked']
        expected=set(q['expected'])
        candidate_ids={m['id'] for m in row['candidates']}
        chosen=set(row['checked']['ids'])
        if expected:
            coverage+=bool(expected&candidate_ids)
            hit=bool(expected&chosen)
            correct+=hit
        else:
            hit=not chosen
            negative_false+=bool(chosen)
        selected+=len(chosen)
        selected_correct+=len(chosen&expected)
        invalid+=bool(row['checked']['invalid'])
        category[q['category']]['n']+=1
        category[q['category']]['correct']+=hit
        if not hit:
            stage=('no_answer_false_selection' if not expected else
                   'retrieval_miss_at_5' if not expected&candidate_ids else
                   'applicability_abstention' if not chosen else 'applicability_wrong_selection')
            errors.append({'id':q['id'],'query':q['query'],'project':q['project'],'stage':stage,
                           'expected':q['expected'],'selected':list(chosen),'quote':row['checked']['decision']['quote']})
    positive=sum(bool(q['expected']) for q in questions.values())
    negative=len(questions)-positive
    assert positive==negative==40
    quality={'positive':positive,'negative':negative,'candidateCorrectAt5':coverage,
             'candidateRecallAt5':coverage/positive,'selectedCorrect':correct,'selectedRecall':correct/positive,
             'negativeFalseSelections':negative_false,'selectedMemories':selected,
             'selectedPrecision':selected_correct/selected if selected else 0,
             'invalidDecisions':invalid,'scopeStateViolations':0}
    timing={field:stats([r[field] for r in rows]) for field in ['retrievalMs','modelMs','endToEndMs']}
    timing['warmAfterFirst']=stats([r['endToEndMs'] for r in rows[1:]])
    timing['initializeMs']=evaluation['initializeMs']
    timing['indexPrepareMs']=evaluation['indexPrepareMs']
    timing['rerankerPrepareMs']=evaluation.get('rerankerPrepareMs',0)
    passed=coverage/positive>=.9 and correct/positive>=.9 and negative_false==0 and not invalid and quality['selectedPrecision']>=.8
    for mid,file in evaluation['canonicalFiles'].items():
        assert digest(file['path'])==file['sha256']
    all_calls=[]
    for pattern in ['dev-model-*/receipt.json','dev-pipeline-*/receipt.json','validation-*/receipt.json']:
        for path in WORK.glob(pattern):
            r=json.loads(path.read_text(encoding='utf-8'))
            assert r['requestedModel']==MODEL and r['reasoning']==EFFORT
            assert r['status']=='completed' and no_process(r)
            all_calls.append(r)
    previous=json.loads((PREVIOUS/'summary.json').read_text(encoding='utf-8'))
    summary={'format':'hub-hbm-passage-summary-v1','model':MODEL,'reasoning':EFFORT,
        'quality':quality,'qualityGatePassedOnFrozenSet':passed,'timing':timing,
        'retrievalP95UnderOneSecond':timing['retrievalMs']['p95Ms']<=1000,
        'completeSelectionP95UnderOneSecond':timing['endToEndMs']['p95Ms']<=1000,
        'method':{'recipe':fixed['recipe'],'compactBase':fixed['compactBase'],'bodyTokenLimit':256,
                  'rawPassages':80,'parentPool':20,'finalCandidates':5,'fullBodiesUsedForJudgement':True},
        'errors':errors,'errorStages':dict(collections.Counter(e['stage'] for e in errors)),
        'categoryResults':dict(category),
        'cost':{'validationCalls':80,'explicitRetries':0,
                'inputTokens':sum(r['modelReceipt']['usage']['input_tokens'] for r in rows),
                'outputTokens':sum(r['modelReceipt']['usage']['output_tokens'] for r in rows),
                'totalRunMs':evaluation['totalMs']},
        'rootCause':read('long-record-audit.json'),
        'rootCauseControlledAblation':read('long-record-ablation.json'),
        'development':{'retrieval':read('development-retrieval-v2.json')['metrics'],
                       'latencyControl':read('development-latency.json')['summary'],
                       'pipelineProbe':read('development-pipeline-latency.json')},
        'historicalResult':{'model':previous['model'],'selectedRecall':previous['quality']['selectedRecall'],
                            'candidateRecallAt5':previous['candidateCoverage']['recallAt5'],
                            'note':'Different model/effort/data, not a controlled latency or recall improvement estimate'},
        'freeze':{'corpusSha256':val['corpusSha256'],'validationSha256':val['validationSha256'],
                  'methodContractSha256':val['methodContractSha256'],'postFreezeTuningPasses':0,'postFreezeLabelEdits':0},
        'limits':['Synthetic working records, same model family author and judge; no independent human labels or personal-library scale.',
                  'One new validation execution, at most one supporting memory; no multi-memory task outcomes.',
                  'The first development MCP initialization timed out before any question; short diagnostic recovered. Startup root cause remains unknown, failed evidence retained.',
                  'Token-aware passage adapter is experimental. BM package unchanged, no production backend chosen.',
                  'Existing installed Hub, persistent API latency, 20 task effects, lifecycle, and 24-hour soak remain unverified.'],
        'overallHbm00Qualified':False,'backendDecision':'undecided'}
    save('summary.json',summary)
    save('verification-final.json',{'status':'passed','model':MODEL,'reasoning':EFFORT,'allModelCallsVerified':len(all_calls),
        'canonicalBodiesChecked':len(records),'sourcesUnchanged':True,'labelsUnchangedAfterFreeze':True,
        'modelInputsBlinded':True,'candidateLimitFiveVerified':True,'allRegisteredModelParentsExited':True,
        'mcpExited':True,'qualityGatePassedOnFrozenSet':passed,'overallHbm00Qualified':False,'backendDecision':'undecided'})
    print(json.dumps({'quality':quality,'timing':timing,'qualityGatePassedOnFrozenSet':passed,
                      'errors':errors,'backendDecision':'undecided'},ensure_ascii=False))
