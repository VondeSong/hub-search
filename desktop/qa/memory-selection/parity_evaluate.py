"""Freeze the shared method, then execute ONE blinded backend holdout."""
import argparse
import json
import time
from pathlib import Path
from parity_support import *
from applicability_policy import POLICY, SCHEMA, validate_decisions

def source_hashes():
    names = ['parity_support.py', 'parity_prepare.py', 'parity_index.py', 'parity_evaluate.py',
             'parity_real_notes.py', 'parity_fixture.py', 'parity_report.py',
             'accounting_support.py', 'accounting_transport.py', 'connection_transport.py',
             'connection_support.py', 'latency_transport.py', 'latency_reuse.py',
             'passage_index.py', 'passage_model.py', 'passage_support.py', 'run.py', 'applicability_policy.py']
    values = {name: digest(Path(__file__).with_name(name)) for name in names}
    values['nativeTest'] = digest(ROOT/'src-tauri/src/agent_work/memory_selection_tests.rs')
    return values

def transport():
    # Reuse the closed latency round's unchanged baseline, but redirect ALL owned
    # paths before importing it. No new transport experiments or global writes.
    import accounting_support as shared
    shared.WORK, shared.HOME, shared.REPORTS = WORK, HOME, REPORTS
    import accounting_transport as native
    return native

def method():
    scope = read('scope-contract.json')
    preflight = read('preflight.json')
    assert preflight['status'] == 'completed'
    save('method-contract.json', {'frozenAt': now(), 'scopeSha256': digest(REPORTS/'scope-contract.json'),
        'method': scope['method'], 'gates': scope['gates'], 'sources': source_hashes(),
        'policySha256': digest(Path(__file__).with_name('applicability_policy.py')),
        'preflightSha256': digest(REPORTS/'preflight.json'), 'model': MODEL, 'effort': EFFORT,
        'representation': 'Common BM parser/semantic-chunk export. Native independently embeds it; no stored vectors copied. Common Hub Tantivy arm. This is component comparison, not independent parser/native deployment proof.',
        'score': 'Positive source-ID correctness and strict frozen required-fragment correctness separately; quality gate uses strict. Any one frozen evidence alternative may match. No post-run relabeling.',
        'calls': 'Skip second backend call only if complete prompt bytes are identical, including question, IDs, order, metadata and exact excerpts. Record reference to first call; no invented independent judgement.'})
    print('Method and scorer frozen before new source selection.')

def preflight():
    from parity_index import Index
    native = transport()
    corpus = {'records': [
        {'id':'m-preflight-a','title':'预检说明','project':'notes','status':'confirmed',
         'content':'这是实验驱动的预检资料，不属于正式验证集。\n\n观察窗口为七天。预算上限不是实际支出，计划不是已经完成的事件。'},
        {'id':'m-preflight-b','title':'预检说明','project':'other','status':'confirmed',
         'content':'另一范围的观察窗口为十天。'}]}
    questions = [
        {'id':'preflight-1','project':'notes','query':'预检说明规定的观察窗口为多久？'},
        {'id':'preflight-2','project':'notes','query':'按预检说明，我们实际上已经花了多少钱？'}]
    result = {'status':'starting','calls':[],'startedAt':now()}
    index = wire = None
    began = time.perf_counter()
    try:
        index = Index(corpus, 'preflight-index')
        index.prepare_bm(); index.prepare_native_vectors()
        lexical = index.native_lexical(questions, read('native-harness.json'), 'preflight')
        wire = native.Wire(WORK/'preflight-server', http=False)
        for number, q in enumerate(questions, 1):
            a = index.retrieve(q, lexical[q['id']], 'hub-native-hybrid')
            b = index.retrieve(q, lexical[q['id']], 'basic-memory-hybrid')
            assert a['candidates'] == b['candidates']
            task = {'id':q['id'],'project':q['project'],'question':q['query'], 'candidateIds':[m['id'] for m in a['candidates']]}
            prompt = POLICY+'\n待核验数据：\n'+json.dumps({'memories':a['candidates'],'tasks':[task]},ensure_ascii=False)
            start = time.time_ns()
            answer, receipt = wire.app_call(prompt, SCHEMA, WORK/f'preflight-call-{number}')
            end = time.time_ns()
            checked = validate_decisions(answer, [task], a['candidates'])[0]
            assert not checked['invalid']
            assert bool(checked['ids']) == (number == 1)
            result['calls'].append({'id':q['id'],'startUnixNs':start,'endUnixNs':end,'receipt':receipt})
        result.update({'status':'completed','embeddingParity':index.embedding_audit})
    finally:
        if wire:
            try:
                result['drain'] = wire.drain(2*len(result['calls']))
            except BaseException as error:
                result.update({'status':'failed','drainErrorType':type(error).__name__})
            finally:
                wire.close()
        if index:
            index.close()
            result['bmResidual'] = index.client.residual if index.client else []
        if wire:
            try:
                result['ledger'] = native.ledger(wire.telemetry.rows,result['calls'])
            except BaseException as error:
                result.update({'status':'failed','ledgerErrorType':type(error).__name__})
        result['wallMs'] = (time.perf_counter()-began)*1000
        save('preflight.json',result)
    print(json.dumps({'preflight':result['status'],'calls':len(result['calls'])}))

def evaluate():
    from parity_index import Index
    method = read('method-contract.json'); frozen = read('validation-contract.json')
    assert method['sources'] == source_hashes()
    assert frozen['corpusSha256'] == digest(REPORTS/'corpus.json')
    assert frozen['validationSha256'] == digest(REPORTS/'validation.json')
    assert frozen['methodSha256'] == digest(REPORTS/'method-contract.json')
    save('execution-start.json',{'startedAt':now(),'sources':source_hashes(),'executionNumber':1})
    corpus, questions = read('corpus.json'), read('validation.json')['cases']
    native = transport()
    result = {'status':'starting','startedAt':now(),'rows':[],'modelCalls':[], 'model':MODEL,'effort':EFFORT,'explicitRetries':0}
    started = time.perf_counter(); index = wire = None
    try:
        index = Index(corpus,'formal-index')
        print(json.dumps({'stage':'passages-written','records':len(index.files),'passages':len(index.passages)}),flush=True)
        index.prepare_bm()
        print(json.dumps({'stage':'bm-index-ready','ms':index.bm_prepare_ms}),flush=True)
        index.prepare_native_vectors()
        print(json.dumps({'stage':'native-vector-ready','ms':index.native_prepare_ms,'embeddingParity':index.embedding_audit}),flush=True)
        lexical = index.native_lexical(questions,read('native-harness.json'),'formal')
        result['indexes']={'bmMs':index.bm_prepare_ms,'bmInitializeMs':index.bm_initialize_ms,
            'nativeVectorMs':index.native_prepare_ms,'sharedHubLexicalMs':index.lexical_receipt['indexMs'],
            'sharedHubLexicalWholeBatchMs':index.lexical_receipt['wallMs'],'embeddingParity':index.embedding_audit,
            'bmResources':index.bm_resources,'records':len(index.files),'passages':len(index.passages),
            'sharedRepresentationSha256':digest(index.root/'common-semantic-inputs.json')}
        model_began = time.perf_counter()
        wire = native.Wire(WORK/'formal-server',http=False)
        result['initializeMs']=wire.initialize_ms
        for number,q in enumerate(questions,1):
            order=['hub-native-hybrid','basic-memory-hybrid']
            if number%2==0:
                order.reverse()
            seen={}
            for backend in order:
                began=time.perf_counter()
                found=index.retrieve(q,lexical[q['id']],backend)
                task={'id':q['id'],'project':q['project'],'question':q['query'],'candidateIds':[m['id'] for m in found['candidates']]}
                prompt=POLICY+'\n待核验数据：\n'+json.dumps({'memories':found['candidates'],'tasks':[task]},ensure_ascii=False)
                key=hashlib.sha256(prompt.encode()).hexdigest()
                shared=key in seen
                if not shared:
                    call_id=f'formal-{number:03}-{len(seen)+1}'
                    start=time.time_ns()
                    answer,receipt=wire.app_call(prompt,SCHEMA,WORK/call_id)
                    end=time.time_ns()
                    seen[key]={'answer':answer,'receipt':receipt,'callId':call_id}
                    result['modelCalls'].append({'id':call_id,'questionId':q['id'],'backend':backend,
                        'startUnixNs':start,'endUnixNs':end,'receipt':receipt})
                call=seen[key]
                checked=validate_decisions(call['answer'],[task],found['candidates'])[0]
                row={'id':q['id'],'backend':backend,'retrieval':found,'checked':checked,
                     'promptSha256':key,'callId':call['callId'],'sharedIdenticalJudgement':shared,
                     'observedHostMs':(time.perf_counter()-began)*1000,
                     'modelMs':call['receipt']['durationMs']}
                save(f'row-{number:03}-{backend}.json',row)
                result['rows'].append(row)
            # Do not inspect expected labels or quality outcomes during execution.
            print(json.dumps({'completedQuestions':number,'total':len(questions),'actualModelCalls':len(result['modelCalls'])}),flush=True)
        result['status']='completed'
    except BaseException as error:
        result.update({'status':'failed','errorType':type(error).__name__})
        raise
    finally:
        if wire:
            try:
                result['drain']=wire.drain(2*len(result['modelCalls']))
            except BaseException as error:
                result.update({'status':'failed','drainErrorType':type(error).__name__})
            finally:
                wire.close()
                result['modelBatchWallMs']=(time.perf_counter()-model_began)*1000
        if index:
            index.close()
            result['bmResidual']=index.client.residual if index.client else []
            result['bmExitCode']=index.client.process.returncode if index.client else None
        if wire:
            try:
                result['ledger']=native.ledger(wire.telemetry.rows,result['modelCalls'])
            except BaseException as error:
                result.update({'status':'failed','ledgerErrorType':type(error).__name__})
        result['totalMs']=(time.perf_counter()-started)*1000
        result['finishedAt']=now()
        save('evaluation.json',result)
    print(json.dumps({'status':result['status'],'rows':len(result['rows']),'modelCalls':len(result['modelCalls'])}))

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('phase',choices=['preflight','method','evaluate'])
    {'preflight':preflight,'method':method,'evaluate':evaluate}[p.parse_args().phase]()
