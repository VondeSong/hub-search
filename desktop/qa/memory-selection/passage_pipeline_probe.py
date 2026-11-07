"""Same-model development latency with the selected generic top-five recipe."""
import json
import statistics
import time

from applicability_policy import POLICY,SCHEMA,validate_decisions
from passage_support import WORK,PREVIOUS,MODEL,EFFORT,read,save,digest
from passage_model import call


if __name__=='__main__':
    development=read('development-retrieval-v2.json')
    assert development['status']=='completed'
    rows={r['id']:r for r in development['results']}
    old=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))
    by_case={q['id']:q for q in json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']}
    corpus=json.loads((PREVIOUS/'corpus.json').read_text(encoding='utf-8'))
    manifest={r['id']:r for r in corpus['records']}
    files=json.loads((WORK/'development-index-v2/passage-manifest.json').read_text(encoding='utf-8'))['records']
    probes=sorted(old['results'],key=lambda r:r['id'])[:4]
    controls={}
    for r in read('development-latency.json')['results']:
        controls.setdefault(r['id'],{})[r['compact']]=r
    compact=all(set(r)=={False,True} and r[False]['checked']['ids']==r[True]['checked']['ids']
                and not r[False]['checked']['invalid'] and not r[True]['checked']['invalid']
                for r in controls.values())
    save('pipeline-probe-contract.json',{'model':MODEL,'reasoning':EFFORT,
        'caseIds':[r['id'] for r in probes],'recipe':development['chosen'],'candidateLimit':5,'compactBase':compact,
        'comparison':'Same four development questions against recorded original-base/20-body control; joint representation/context optimization, not a same-input attribution.',
        'tuning':'No choices made from this probe; final frozen validation is still not generated.'})
    results=[]
    for number,probe in enumerate(probes,1):
        q=by_case[probe['id']]
        start=time.perf_counter()
        candidates=[]
        for mid in rows[q['id']][development['chosen']][:5]:
            memory=manifest[mid]
            assert memory['project']==q['project'] and memory['status']=='confirmed'
            assert digest(files[mid]['path'])==files[mid]['sha256']
            candidates.append({'id':mid,'project':q['project'],'status':'confirmed',
                               'title':memory['title'],'text':memory['content']})
        task={'id':q['id'],'project':q['project'],'question':q['query'],
              'candidateIds':[m['id'] for m in candidates]}
        prompt=POLICY+'\n待核验数据：\n'+json.dumps({'project':{'id':q['project']},'memories':candidates,'tasks':[task]},ensure_ascii=False)
        response,receipt=call(prompt,SCHEMA,f'dev-pipeline-{number:02}',compact=compact)
        checked=validate_decisions(response,[task],candidates)[0]
        results.append({'id':q['id'],'receipt':receipt,'checked':checked,
                         'modelWithCanonicalChecksMs':(time.perf_counter()-start)*1000})
        print(json.dumps({'pipelineProbe':number,'durationMs':receipt['durationMs'],
                          'inputTokens':receipt['usage']['input_tokens']}),flush=True)
    save('development-pipeline-latency.json',{'status':'completed','results':results,
         'model':MODEL,'reasoning':EFFORT,'medianModelMs':statistics.median(r['receipt']['durationMs'] for r in results),
         'inputTokens':sum(r['receipt']['usage']['input_tokens'] for r in results),
         'limits':'Four development probes, actual model calls but no repeated retrieval timing; new validation measures actual full chain.'})
