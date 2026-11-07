"""One predeclared twelve-case paired comparison, with identical blinded payloads."""
import json
from pathlib import Path
import statistics
import time

from applicability_policy import POLICY, SCHEMA, validate_decisions
from latency_support import ROOT, WORK, PREVIOUS, save, digest
from latency_transport import Wire


def actor_sources():
    return {n:digest(Path(__file__).with_name(n)) for n in [
        'latency_support.py','latency_transport.py','latency_develop.py',
        'applicability_policy.py','passage_index.py','passage_model.py','passage_support.py','run.py']}


if __name__=='__main__':
    questions=json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']
    selected=sorted(questions,key=lambda q:q['id'])[:12]
    payloads={}
    for q in selected:
        number=next(i+1 for i,t in enumerate(questions) if t['id']==q['id'])
        path=ROOT/f'.local/hbm-00/passages-20261018/validation-{number:03}/input.txt'
        payloads[q['id']]=path.read_text(encoding='utf-8')
    save('development-contract.json',{'cases':[q['id'] for q in selected],
        'inputs':{q['id']:digest(ROOT/f'.local/hbm-00/passages-20261018/validation-{questions.index(q)+1:03}/input.txt') for q in selected},
        'actorSources':actor_sources(),'modes':['cli','fresh','persistent'],
        'order':'Three-mode cyclic rotation for each question, no parallel model requests.',
        'pairedRule':'Eligible only if all 12 outcomes exact and protocol/source checks pass. Lowest paired median; persistent improvement requires >=10% median paired saving and >=8/12 faster vs fresh CLI.',
        'excludedSessionReuse':'thread/rollback removed; ephemeral thread/revert unsupported. No history reuse or injection.',
        'callLimit':36,'explicitRetries':0,'model':'gpt-6.1-sol','effort':'xhigh'})
    results=[]
    persistent=None
    started=time.perf_counter()
    try:
        persistent=Wire(WORK/'development-persistent','app')
        for index,q in enumerate(selected):
            order=['cli','fresh','persistent']
            order=order[index%3:]+order[:index%3]
            prompt=payloads[q['id']]
            payload=json.loads(prompt[len(POLICY+'\n待核验数据：\n'):])
            assert set(payload)=={'project','memories','tasks'}
            for mode in order:
                wire=None
                name=f'development-{index+1:02}-{mode}'
                try:
                    if mode=='persistent':
                        response,receipt=persistent.app_call(prompt,SCHEMA,WORK/name)
                        elapsed=receipt['durationMs']
                        initialize=0
                    else:
                        wire=Wire(WORK/(name+'-server'), 'cli' if mode=='cli' else 'app', SCHEMA if mode=='cli' else None)
                        if mode=='cli':
                            response,receipt=wire.cli_call(prompt,SCHEMA)
                        else:
                            response,receipt=wire.app_call(prompt,SCHEMA,WORK/name)
                        elapsed=(time.perf_counter()-wire.began)*1000
                        initialize=getattr(wire,'initialize_ms',None)
                    checked=validate_decisions(response,payload['tasks'],payload['memories'])[0]
                    row={'id':q['id'],'mode':mode,'callMs':elapsed,'initializeMs':initialize,
                         'checked':checked,'correct':not checked['invalid'] and set(checked['ids'])==set(q['expected']),
                         'receipt':receipt,'promptSha256':receipt['inputSha256']}
                    save(name+'.json',row)
                    results.append(row)
                    print(json.dumps({'callsCompleted':len(results),'total':36,'case':index+1,'mode':mode,'callMs':round(elapsed,2)}),flush=True)
                finally:
                    if wire:
                        wire.close()
        by_mode={mode:[r for r in results if r['mode']==mode] for mode in ['cli','fresh','persistent']}
        medians={mode:statistics.median(r['callMs'] for r in rows) for mode,rows in by_mode.items()}
        eligible={mode:all(r['correct'] for r in rows) for mode,rows in by_mode.items()}
        candidate=min((mode for mode in by_mode if eligible[mode]),key=lambda mode:medians[mode])
        base={r['id']:r['callMs'] for r in by_mode['cli']}
        savings={mode:[1-r['callMs']/base[r['id']] for r in rows] for mode,rows in by_mode.items()}
        improvements={mode:{'medianPairedSaving':statistics.median(v),'fasterCases':sum(x>0 for x in v)} for mode,v in savings.items()}
        demonstrated=candidate!='cli' and improvements[candidate]['medianPairedSaving']>=.10 and improvements[candidate]['fasterCases']>=8
        chosen=candidate if demonstrated else 'cli'
        save('development.json',{'status':'completed','results':results,'mediansMs':medians,
            'eligible':eligible,'paired':improvements,'chosen':chosen,'improvementDemonstrated':demonstrated,
            'persistentInitializeMs':persistent.initialize_ms,'totalMs':(time.perf_counter()-started)*1000,
            'limits':'Same machine sequential crossover; twelve disclosed development questions, no independent significance claim. Fresh CLI ignores user config; app-server has no ignore flag, connector/features/model/base/tier overridden per invocation; startup is inclusive, warm persistent startup separate.'})
        print(json.dumps({'mediansMs':medians,'paired':improvements,'chosen':chosen,'improvementDemonstrated':demonstrated}))
    finally:
        if persistent:
            persistent.close()
