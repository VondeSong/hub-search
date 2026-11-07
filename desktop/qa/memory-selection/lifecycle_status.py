"""Bounded read-only projection of operational progress, no service calls."""
import sqlite3
from lifecycle_support import *
for kind in ['bm','native']:
    report=REPORTS/f'{kind}-formal-v2-result.json';progress=WORK/f'{kind}-v2-progress.json'
    result={'arm':kind}
    if report.exists() or progress.exists():
        r=read(report if report.exists() else progress)
        result.update(status=r['status'],operations=len(r['operations']),completed=sum(x['status']=='completed' for x in r['operations']),passed=sum(x.get('passed',False) for x in r['operations']),coldRuns=len(r['cold']))
        if report.exists():result.update(error=r.get('error'),allLifecycleGatesPassed=r.get('allLifecycleGatesPassed'),backupRestorePassed=r.get('backupRestorePassed'))
    else:result['status']='no final/progress receipt yet'
    db=WORK/f'{kind}-formal-v2'/('config/memory.db' if kind=='bm' else 'craft-search.sqlite3')
    if db.exists():
        try:
            with sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True) as c:
                if kind=='bm':result['index']=c.execute('SELECT embedding_status,count(*) FROM search_vector_chunks GROUP BY embedding_status').fetchall()
                else:result['vectors']=c.execute('SELECT count(*) FROM hbm_vectors').fetchone()[0]
        except sqlite3.Error as e:result['indexStatus']=type(e).__name__
    print(json.dumps(result,ensure_ascii=False))
