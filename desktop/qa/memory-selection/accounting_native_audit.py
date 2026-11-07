"""Bounded native client diagnostics, redacted before output; no model calls."""
import json
import os
from pathlib import Path
import re
import sqlite3
from accounting_support import WORK,read,save

if __name__=='__main__':
    auth=json.loads((Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json').read_text(encoding='utf-8'))
    secrets=[v for k,v in auth['tokens'].items() if k in ['access_token','id_token','refresh_token'] and isinstance(v,str)]
    con=sqlite3.connect((WORK/'shared-codex-state/logs_2.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    rows=con.execute('SELECT target,feedback_log_body FROM logs WHERE target=? ORDER BY ts,ts_nanos',('codex_http_client::client',)).fetchall()
    con.close(); safe=[]
    for target,body in rows:
        body=body or ''
        for secret in secrets:
            body=body.replace(secret,'[redacted]')
        body=re.sub(r'(?i)bearer\s+[^ ,"]+','[redacted]',body)
        body=re.sub(r'[\w.+-]+@[\w.-]+','[redacted-email]',body)
        body=re.sub(r'[A-Za-z0-9_-]{25,}','[opaque]',body)
        safe.append({'target':target,'tail':body[-700:]})
    d=read('preflight-reset-http.json')
    sockets=[{'id':q['id'],'ids':sorted({s['socketIdentity'] for r in d['tcpObservation']['samples'] if q['startUnixNs']<=r['unixNs']<=q['endUnixNs'] for s in r['sockets'] if s['state']==5})} for q in d['questions']]
    save('native-client-audit.json',{'rows':safe,'socketsPerQuestion':sockets,'modelCalls':0})
    print(json.dumps({'rows':safe,'sockets':sockets},ensure_ascii=True))
