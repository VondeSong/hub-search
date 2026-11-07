"""Read-only bounded progress snapshot; no model or lifecycle mutations."""
import json
import sqlite3
from qualification_contract import WORK,REPORTS

area=WORK/'bm-lifecycle';state=area/'state';out={}
db=state/'config/memory.db'
if db.exists():
    try:
        with sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True,timeout=2) as c:
            out['entities']=c.execute('SELECT count(*) FROM entity').fetchone()[0]
            out['chunksByState']=c.execute('SELECT embedding_status,count(*) FROM search_vector_chunks GROUP BY embedding_status').fetchall()
    except sqlite3.Error as e:out['readinessError']=str(e)
if (area/'progress.json').exists():
    p=json.loads((area/'progress.json').read_text(encoding='utf-8'))
    out['operationsCompleted']=sum(x['status']=='completed' for x in p['operations'])
    out['coldRuns']=[{'number':x['number'],'firstUsableMs':x['firstUsableMs'],'within10s':x['within10s']} for x in p['coldRuns']]
if (REPORTS/'bm-lifecycle-result.json').exists():
    p=json.loads((REPORTS/'bm-lifecycle-result.json').read_text(encoding='utf-8'))
    out['result']={k:p.get(k) for k in ['status','errorType','error','wallMs','backupRestorePassed','residual']}
print(json.dumps(out,ensure_ascii=False))
