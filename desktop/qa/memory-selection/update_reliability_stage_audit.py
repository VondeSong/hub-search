"""Offline audit; ranks from frozen post-query snapshots, never new scoring."""
import asyncio,pickle
import numpy as np
from update_reliability import *
from basic_memory.repository.fastembed_provider import FastEmbedEmbeddingProvider

async def main():
    area=ROOT/'.local/hbm-00/update-reliability-fix-20261019'
    out=ROOT/'artifacts/hbm-00-update-reliability-fix-20261019'
    result=read(out/'replay.json');assert result['status']=='completed' and not result['residual']
    save(out/'stage-audit-contract.json',{'at':now(),'sourceSha256':digest(__file__),'resultSha256':digest(out/'replay.json'),
      'scope':'Offline frozen post-query SQL transaction snapshots; no rerun, model change or score change. Same original query embeddings. Snapshot starts after response, so cannot assert an atomic live-query trace. Physical ranks, hash joins, project and search-row hydration separately.'})
    cfg=read(area/'replay/config/config.json')
    model=FastEmbedEmbeddingProvider(cfg['semantic_embedding_model'],batch_size=2,dimensions=512,cache_dir=cfg['semantic_embedding_cache_dir'],threads=2)
    rows=[]
    for n,row in enumerate(result['updates']):
        with (area/f'{n:02}-after.pickle').open('rb') as f:d=pickle.load(f)
        q=np.array(await model.embed_query(body(n,1)[:230].strip()),dtype=np.float32)
        vectors=d['vectors'];arr=np.stack([np.frombuffer(r['embedding'],dtype='<f4') for r in vectors])
        ranked=sorted(zip(vectors,np.linalg.norm(arr-q,axis=1)),key=lambda p:(float(p[1]),p[0]['vector_id']))
        mid=row['id'];target=[(rank+1,r,float(dist)) for rank,(r,dist) in enumerate(ranked) if r['permalink']==mid]
        keys={(r['type'],r['id']):r for r in d['index'] if r['project_id']==d['projects']['left']}
        candidates=[]
        for rank,(r,dist) in enumerate(ranked[:500],1):
            parts=r['chunk_key'].split(':');key=(parts[0],int(parts[1]));si=keys.get(key)
            candidates.append({'rank':rank,'id':r['permalink'],'distance':float(dist),'projectMatches':r['project_id']==d['projects']['left'],
               'sourceHashMatches':r['source_hash']==r['vector_hash'],'ready':r['embedding_status']=='ready',
               'searchRowPresent':si is not None,'ownerMatches':si is not None and si['entity_id']==r['entity_id'],
               'chunkNewVersion':'V1' in r['chunk_text'],'searchRowNewVersion':si is not None and 'V1' in (si['content_snippet'] or '')})
        target_candidates=[c for c in candidates if c['id']==mid]
        item={'id':mid,'primaryHit':mid in row['primaryQuery']['vectorIds'] and mid in row['primaryQuery']['lexicalIds'],
          'retryVectorHit':mid in row['query']['vectorIds'],'retryLexicalHit':mid in row['query']['lexicalIds'],
          'queryAfterAckMs':row['query']['postAckQueryCompleteMs'],'snapshotPhysicalCount':len(vectors),
          'targetPhysicalCount':len(target),'targetBestGlobalRank':target[0][0] if target else None,
          'targetCandidatesIn500':len(target_candidates),'targetProjectRejections':sum(not c['projectMatches'] for c in target_candidates),
          'targetHashMismatches':sum(not c['sourceHashMatches'] for c in target_candidates),
          'targetMissingSearchRows':sum(not c['searchRowPresent'] for c in target_candidates),
          'targetNotReady':sum(not c['ready'] for c in target_candidates),
          'targetSearchRows':sum(r['permalink']==mid for r in d['index']),
          'snapshotSha256':digest(area/f'{n:02}-after.pickle'),'candidates':candidates}
        rows.append(item)
        print(json.dumps({k:v for k,v in item.items() if k not in ['candidates','snapshotSha256']}),flush=True)
    save(out/'stage-audit.json',{'at':now(),'rows':rows,'modelCalls':0,'readOnly':True})

if __name__=='__main__':asyncio.run(main())
