"""Read-only schema and synthetic-workload contract checks; no service launch."""
import json
from qualification_contract import ROOT, REPORTS, save, now
from qualification_bm_lifecycle import body, inspect
from basic_memory.repository.semantic_chunking import split_text_into_chunks

counts=[len(split_text_into_chunks(body(i))) for i in range(100)]
maximum=max(len(body(i).encode()) for i in range(100))
state=ROOT/'.local/hbm-00/grounding-20261018c/formal-index/bm'
data=inspect(state)
assert counts==[50]*100 and maximum<=60000
assert not data['orphanVectors'] and not data['orphanChunks'] and not data['orphanSearch']
save('operational-preflight.json',{'at':now(),'readOnly':True,'serviceLaunched':False,
    'syntheticNotes':100,'entityChunksExpected':sum(counts),'maxNoteBytes':maximum,
    'oldSchemaReadable':True,'oldState':str(state),'oldCounts':{k:len(data[k]) for k in ['entities','chunks','search']},
    'productionOrVaultModified':False,'doesNotCountAsLifecycleOrStartupTest':True})
print(json.dumps({'notes':100,'chunks':sum(counts),'maxBytes':maximum,'oldSchemaReadable':True}))
