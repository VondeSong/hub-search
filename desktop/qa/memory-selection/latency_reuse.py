"""Conditional fourth mode: owned paginated session, verified history reset, same connection."""
import json
from pathlib import Path
import statistics
import time

from applicability_policy import POLICY, SCHEMA, validate_decisions
from latency_support import ROOT, WORK, PREVIOUS, MODEL, EFFORT, save, read, digest
from latency_transport import Wire, write
from passage_model import BASE


class ReusableSession:
    def __init__(self, name, telemetry=False):
        self.wire=Wire(WORK/name,'app',telemetry_enabled=telemetry)
        self.closed=False
        try:
            setup=self.wire.rpc('thread/start',{'model':MODEL,'allowProviderModelFallback':False,
                'cwd':str(self.wire.directory),'ephemeral':False,'historyMode':'paginated',
                'sandbox':'read-only','approvalPolicy':'never','baseInstructions':BASE,
                'developerInstructions':'','dynamicTools':[],'serviceTier':'default',
                'config':{'model_reasoning_effort':EFFORT}})
            self.setup=setup
            self.thread=setup['thread']['id']
            write(self.wire.directory/'owned-thread.json',setup)
            path=setup['thread'].get('path')
            # Paginated native SQLite must be the experiment-owned store; refuse rollout outside it.
            if path and not Path(path).resolve().is_relative_to(WORK.resolve()):
                self.wire.rpc('thread/archive',{'threadId':self.thread})
                raise RuntimeError('Persistent session path is outside experiment root; no model call allowed')
            assert setup['model']==MODEL and setup['reasoningEffort']==EFFORT
            self.empty_history()
        except BaseException:
            self.wire.close()
            raise

    def empty_history(self):
        turns=self.wire.rpc('thread/turns/list',{'threadId':self.thread,'limit':1,'sortDirection':'desc','itemsView':'full'})
        items=self.wire.rpc('thread/items/list',{'threadId':self.thread,'limit':1,'sortDirection':'desc'})
        assert turns['data']==[] and items['data']==[]
        assert turns.get('nextCursor') is None and items.get('nextCursor') is None
        return {'turns':turns,'items':items}

    def call(self,prompt,schema,directory):
        began=time.perf_counter()
        directory.mkdir(parents=True,exist_ok=False)
        before=self.empty_history()
        (directory/'input.txt').write_text(prompt,encoding='utf-8')
        write(directory/'schema.json',schema)
        write(directory/'history-before.json',before)
        offset=(time.perf_counter()-self.wire.began)*1000
        response=self.wire.rpc('turn/start',{'threadId':self.thread,'model':MODEL,'effort':EFFORT,
            'summary':'none','input':[{'type':'text','text':prompt}],'outputSchema':schema,
            'approvalPolicy':'never','sandboxPolicy':{'type':'readOnly'},'serviceTierForTurn':'default'})
        turn_id=response['turn']['id']
        deadline=time.monotonic()+120
        pending=self.wire.pending
        self.wire.pending=[]
        used=[]
        completed=None
        while completed is None:
            row=pending.pop(0) if pending else self.wire.next(deadline)
            event=row['event']
            params=event.get('params',{})
            if params.get('threadId')!=self.thread:
                continue
            if params.get('turnId') and params['turnId']!=turn_id:
                continue
            if params.get('turn',{}).get('id') and params['turn']['id']!=turn_id:
                continue
            used.append(row)
            if event.get('method')=='error':
                raise RuntimeError('Model turn failed; full protocol retained')
            if params.get('item',{}).get('type') not in [None,'userMessage','agentMessage','reasoning']:
                raise RuntimeError('Tool-free contract violated')
            if event.get('method')=='turn/completed' and params['turn']['id']==turn_id:
                completed=params['turn']
                assert completed['status']=='completed' and not completed.get('error')
        texts=[r['event']['params']['item']['text'] for r in used
               if r['event'].get('method')=='item/completed' and r['event']['params'].get('item',{}).get('type')=='agentMessage']
        assert len(texts)==1
        answer=json.loads(texts[0])
        write(directory/'output.json',answer)
        first=lambda predicate:next((r['ms']-offset for r in used if predicate(r['event'])),None)
        usage=[r['event']['params']['tokenUsage']['last'] for r in used if r['event'].get('method')=='thread/tokenUsage/updated']
        revert_began=time.perf_counter()
        reverted=self.wire.rpc('thread/revert',{'threadId':self.thread,'beforeTurnId':turn_id})
        after=self.empty_history()
        write(directory/'history-after.json',{'revert':reverted,**after})
        receipt={'status':'completed','model':MODEL,'effort':EFFORT,'mode':'history-reset-session',
            'pid':self.wire.process.pid,'createTime':self.wire.create_time,'threadId':self.thread,'turnId':turn_id,
            'ephemeral':False,'freshEmptyHistory':True,'historyRevertedAndVerified':True,
            'submitToTurnStartedMs':first(lambda e:e.get('method')=='turn/started'),
            'submitToFirstReasoningItemMs':first(lambda e:e.get('method')=='item/started' and e['params'].get('item',{}).get('type')=='reasoning'),
            'submitToFirstAnswerDeltaMs':first(lambda e:e.get('method')=='item/agentMessage/delta'),
            'submitToCompletionMs':used[-1]['ms']-offset,'serverTurnDurationMs':completed.get('durationMs'),
            'historyResetMs':(time.perf_counter()-revert_began)*1000,
            'usage':usage[-1] if usage else None,'explicitRetries':0,'toolCalls':0,
            'inputSha256':digest(directory/'input.txt'),'outputSha256':digest(directory/'output.json'),
            'durationMs':(time.perf_counter()-began)*1000}
        write(directory/'thread-start.json',self.setup)
        write(directory/'events.json',used)
        write(directory/'receipt.json',receipt)
        return answer,receipt

    def close(self):
        if not self.closed:
            self.closed=True
            try:
                self.empty_history()
                self.wire.rpc('thread/archive',{'threadId':self.thread})
            finally:
                self.wire.close()


if __name__=='__main__':
    dev=read('development.json')
    assert dev['status']=='completed'
    selected_ids=read('development-contract.json')['cases']
    questions=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    save('reuse-contract.json',{'purpose':'Conditional fourth option already named in initial scope, after protocol discovery; do not revise three-mode outcomes.',
        'cases':selected_ids,'callsMax':12,'sourceSha256':digest(Path(__file__)),
        'transportSha256':digest(Path(__file__).with_name('latency_transport.py')),
        'history':'Native experiment-owned paginated store, before/after turns+items must both be empty; archive own empty session at exit.',
        'selection':'Same gates and >=10% median paired saving plus >=8/12 faster vs CLI; no validation questions exist yet.',
        'observation':'Local allowlisted OTel enabled for this candidate, no socket polling. Includes reset and verification cost.'})
    session=None
    rows=[]
    unavailable=None
    try:
        try:
            session=ReusableSession('development-reuse',telemetry=True)
        except (RuntimeError,AssertionError) as error:
            unavailable={'errorType':type(error).__name__,'message':str(error)}
        if session:
            for i,ident in enumerate(selected_ids,1):
                q=next(q for q in questions if q['id']==ident)
                number=questions.index(q)+1
                prompt=(ROOT/f'.local/hbm-00/passages-20261018/validation-{number:03}/input.txt').read_text(encoding='utf-8')
                payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
                answer,receipt=session.call(prompt,SCHEMA,WORK/f'development-{i:02}-reuse')
                checked=validate_decisions(answer,payload['tasks'],payload['memories'])[0]
                row={'id':ident,'mode':'reuse','callMs':receipt['durationMs'],'receipt':receipt,
                     'checked':checked,'correct':not checked['invalid'] and set(checked['ids'])==set(q['expected'])}
                save(f'development-{i:02}-reuse.json',row)
                rows.append(row)
                print(json.dumps({'completed':i,'total':12,'callMs':round(row['callMs'],2)}),flush=True)
    finally:
        if session:
            session.close()
    base={r['id']:r['callMs'] for r in dev['results'] if r['mode']=='cli'}
    saving=[1-r['callMs']/base[r['id']] for r in rows]
    eligible=len(rows)==12 and all(r['correct'] for r in rows)
    improvement=eligible and statistics.median(saving)>=.1 and sum(v>0 for v in saving)>=8
    median=statistics.median(r['callMs'] for r in rows) if rows else None
    prior_chosen=dev['chosen']
    choose_reuse=improvement and median<dev['mediansMs'][prior_chosen]
    save('reuse-development.json',{'status':'completed' if session else 'unavailable','results':rows,'unavailable':unavailable,
        'eligible':eligible,'medianMs':median,'medianPairedSaving':statistics.median(saving) if saving else None,
        'fasterCases':sum(v>0 for v in saving),'improvementDemonstrated':improvement,
        'chosen':'reuse' if choose_reuse else prior_chosen,
        'limits':'This conditional mode follows the three-way run rather than interleaving; time/cache drift is confounded. OTel timing adds observation. No causal speed claim from this comparison alone.'})
    print(json.dumps({'eligible':eligible,'improvementDemonstrated':improvement,'chosen':'reuse' if choose_reuse else prior_chosen}))
