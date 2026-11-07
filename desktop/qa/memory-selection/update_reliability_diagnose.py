"""Read-only stage reconstruction from the exact 100-note replay snapshots."""
import asyncio
import numpy as np
from update_reliability import *
from basic_memory.repository.fastembed_provider import FastEmbedEmbeddingProvider

async def main():
    replay=read(OUT/'replay.json');assert replay['status']=='completed' and not replay['residual']
    save(OUT/'offline-method.json',{'at':now(),'sourceSha256':digest(__file__),'replaySha256':digest(OUT/'replay.json'),
      'method':'Same provider query embeddings, frozen exact230char original queries; sqlite-vec global top500 and full physical distance rank, source-hash/model/status checks, project filter, search_index hydration. No mutations or rescoring. Before and after snapshots inspected separately.'})
    cfg=read(AREA/'replay/config/config.json')
    provider=FastEmbedEmbeddingProvider(cfg['semantic_embedding_model'],batch_size=2,dimensions=cfg['semantic_embedding_dimensions'],cache_dir=cfg['semantic_embedding_cache_dir'],threads=2)
    output=[]
    for n,row in enumerate(replay['updates']):
        q=await provider.embed_query(body(n,1)[:230].strip());mid=row['id'];stages=[]
        for phase in ['before','after']:
            with connect(AREA/f'{n:02}-{phase}.db') as c:
                c.row_factory=sqlite3.Row
                project=c.execute("SELECT id FROM project WHERE name='left'").fetchone()[0]
                allrows=[dict(r) for r in c.execute('''SELECT v.rowid AS vector_id,v.embedding,v.source_hash AS vector_hash,
                  c.entity_id,c.project_id,c.source_hash,c.chunk_key,c.embedding_status,c.embedding_model,
                  c.chunk_text,e.permalink FROM search_vector_embeddings v
                  LEFT JOIN search_vector_chunks c ON c.id=v.rowid LEFT JOIN entity e ON e.id=c.entity_id''')]
                arr=np.stack([np.frombuffer(r['embedding'],dtype='<f4') for r in allrows])
                distances=np.linalg.norm(arr-np.array(q,dtype=np.float32),axis=1)
                ordered=sorted(zip(allrows,distances),key=lambda t:(float(t[1]),t[0]['vector_id']))
                target=[(i+1,r,float(d)) for i,(r,d) in enumerate(ordered) if r['permalink']==mid]
                top=[dict(r) for r in c.execute('SELECT rowid,distance FROM search_vector_embeddings WHERE embedding MATCH ? AND k=500 ORDER BY distance', (json.dumps(q),))]
                byid={r['vector_id']:r for r in allrows};keys={(r['type'],r['id']):dict(r) for r in c.execute('SELECT id,type,entity_id,project_id,permalink,content_snippet FROM search_index WHERE project_id=?',(project,))}
                candidates=[]
                for rank,t in enumerate(top,1):
                    r=byid[t['rowid']];parts=(r['chunk_key'] or '').split(':');key=(parts[0],int(parts[1])) if len(parts)>1 else None
                    indexed=keys.get(key)
                    candidates.append({'globalRank':rank,'distance':t['distance'],'id':r['permalink'],'projectId':r['project_id'],
                      'chunkKey':r['chunk_key'],'sourceHashMatches':r['source_hash']==r['vector_hash'],'ready':r['embedding_status']=='ready',
                      'projectMatches':r['project_id']==project,'searchRowPresent':indexed is not None,
                      'searchRowOwnerMatches':indexed is not None and indexed['entity_id']==r['entity_id'],
                      'chunkNewVersion':'V1' in (r['chunk_text'] or ''),
                      'searchRowNewVersion':indexed is not None and 'V1' in (indexed['content_snippet'] or '')})
                scoped=[r for r,d in ordered if r['project_id']==project]
                targetkeys=[r for rank,r,d in target]
                stage={'phase':phase,'physicalVectors':len(allrows),'targetPhysicalVectors':len(target),
                  'targetBestGlobalRank':target[0][0] if target else None,
                  'targetBestProjectRank':next((i+1 for i,r in enumerate(scoped) if r['permalink']==mid),None),
                  'targetSourceHashMismatches':sum(r['source_hash']!=r['vector_hash'] for r in targetkeys),
                  'targetNotReady':sum(r['embedding_status']!='ready' for r in targetkeys),
                  'targetInGlobal500':sum(r['id']==mid for r in candidates),
                  'targetSurvivesProject':sum(r['id']==mid and r['projectMatches'] for r in candidates),
                  'targetHydrated':sum(r['id']==mid and r['projectMatches'] and r['sourceHashMatches'] and r['ready'] and r['searchRowOwnerMatches'] for r in candidates),
                  'global500Candidates':candidates}
                stages.append(stage)
        item={'id':mid,'livePassed':row['passed'],'liveRank':row['query']['rank'],'liveLexicalFound':mid in row['query']['lexicalIds'],'stages':stages}
        save(OUT/f'diagnosis-{n:02}.json',item);output.append(item)
        print(json.dumps({'id':mid,'liveRank':item['liveRank'],'stages':[{k:v for k,v in a.items() if k!='global500Candidates'} for a in stages]}),flush=True)
    save(OUT/'diagnosis.json',{'at':now(),'rows':output,'readOnly':True,'scoresUnchanged':True})

if __name__=='__main__':asyncio.run(main())
