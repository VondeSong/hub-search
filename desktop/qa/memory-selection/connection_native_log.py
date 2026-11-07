"""Allowlisted, credential-redacted messages for the exact old slow thread."""
import json
import re
import sqlite3
from pathlib import Path
from connection_support import ROOT,PREVIOUS,save

if __name__=='__main__':
    r=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))['results'][36]
    auth=json.loads((Path.home()/'.codex/auth.json').read_text(encoding='utf-8')).get('tokens',{})
    secrets=[v for k,v in auth.items() if k.endswith('token') and isinstance(v,str)]
    db=ROOT/'.local/hbm-00/latency-20261018/shared-codex-state/logs_2.sqlite'
    c=sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True)
    rows=c.execute('SELECT ts,ts_nanos,level,target,feedback_log_body FROM logs WHERE thread_id=? AND target IN (?,?,?) ORDER BY ts,ts_nanos',
        (r['modelReceipt']['threadId'],'codex_core::client','codex_core::stream_events_utils','codex_core::session::turn')).fetchall()
    projected=[]
    for ts,ns,level,target,body in rows:
        text=body or ''
        for value in secrets:
            text=text.replace(value,'[credential removed]')
        text=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[jwt removed]',text)
        text=re.sub(r'(?i)(bearer\s+)[A-Za-z0-9_.-]+',r'\1[removed]',text)
        projected.append({'ts':ts,'ns':ns,'level':level,'target':target,'body':text[:1400]})
    c.close()
    save('prior-native-log.json',{'threadId':r['modelReceipt']['threadId'],'rows':projected,
        'limits':'Only known targets of the exact previous slow thread. retry substring may be configuration, not a retry event.'})
    print(json.dumps(projected,ensure_ascii=False))
