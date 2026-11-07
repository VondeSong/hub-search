"""After both frozen runs, inspect original/control queries on restored state.

Original scores stay frozen. Exact stored-chunk queries are diagnostic controls,
not replacement acceptance questions or a third scored run.
"""
from lifecycle_support import *
from lifecycle_bm import BM,body,chunks
from lifecycle_native import Native

def diagnose():
    results={kind:read(REPORTS/f'{kind}-formal-v2-result.json') for kind in ['bm','native']}
    assert all(r['status']=='completed' for r in results.values())
    selected={0,19,60,79,80,99,100,119}
    for r in results.values():
        for row in r['operations']:
            n=int(row['id'].split('-')[-1])
            if row.get('newVersionRetrieved') is False:selected.add(n)
            if row.get('successorRetrieved') is False:selected.add(n+60)
    save(REPORTS/'retrieval-diagnosis-method.json',{'at':now(),'sourceSha256':digest(__file__),'selectedNumbers':sorted(selected),
        'queryPair':['unchanged original230character query','exact first body chunk already stored'],
        'rules':'No model/config/query ranking changes. Read-only calls after both closed formal runs. Preserve failed gate flags and compare same sources on both arms. No validation rescoring.',
        'limitation':'Final corpus has80notes after deletes/replacements; changed neighbor competition means a later hit cannot establish that an earlier miss was a transient race. This is final-state inspection only.'})
    output={}
    for kind,factory in [('bm',BM),('native',Native)]:
        client=None;rows=[];started=time.perf_counter()
        try:
            client=factory(WORK/f'{kind}-restored-v2')
            for n in sorted(selected):
                mid=f'hbm-op-{n:03}';rev=1 if n<20 else 0;content=body(n,rev);project='right' if 80<=n<100 else 'left'
                query=content[:230];exact=chunks(mid,content)[1];term=f'核对口令是HBMOP{n:03}S00V{rev}'
                original=client.search(query,project,term);control=client.search(exact,project,term)
                rows.append({'id':mid,'project':project,'originalQuerySha256':hashlib.sha256(query.encode()).hexdigest(),
                  'controlQuerySha256':hashlib.sha256(exact.encode()).hexdigest(),
                  'originalVectorFound':mid in original['vectorIds'],'originalLexicalFound':mid in original['lexicalIds'],
                  'exactChunkVectorFound':mid in control['vectorIds'],'exactChunkLexicalFound':mid in control['lexicalIds'],
                  'originalVectorIds':original['vectorIds'],'controlVectorIds':control['vectorIds']})
        finally:
            residual=client.close() if client else []
            output[kind]={'rows':rows,'wallMs':(time.perf_counter()-started)*1000,'residual':residual}
            save(REPORTS/f'{kind}-retrieval-diagnosis.json',output[kind])
    print(json.dumps({k:{'n':len(v['rows']),'originalVectorMisses':[r['id'] for r in v['rows'] if not r['originalVectorFound']],
        'controlVectorMisses':[r['id'] for r in v['rows'] if not r['exactChunkVectorFound']],
        'lexicalMisses':[r['id'] for r in v['rows'] if not r['originalLexicalFound']]} for k,v in output.items()}))
if __name__=='__main__':diagnose()
