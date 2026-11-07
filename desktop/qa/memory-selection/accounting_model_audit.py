"""Project only model-routing header names, never arbitrary HTTP headers/cookies."""
import json
import re
import sqlite3
from accounting_support import WORK,save
if __name__=='__main__':
    con=sqlite3.connect((WORK/'shared-codex-state/logs_2.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    rows=con.execute('SELECT ts,ts_nanos,thread_id,feedback_log_body FROM logs WHERE target=? ORDER BY ts,ts_nanos',('codex_http_client::client',)).fetchall(); con.close()
    result=[]
    for sec,ns,thread,body in rows:
        normalized=(body or '').replace('\\"','"')
        headers=[{'name':key,'model':model} for key,model in re.findall(r'"([^"\s]+)"\s*:\s*"(gpt-[^"\s]+)"',normalized)]
        if headers:
            result.append({'unixNs':sec*1_000_000_000+ns,'threadId':thread,'modelHeaders':headers,
                           'httpVersion':'1.1' if 'HTTP/1.1' in normalized else '2' if 'HTTP/2' in normalized else None})
    save('model-header-audit.json',{'rows':result,'modelCalls':0,'arbitraryHeadersExported':False})
    print(json.dumps(result,ensure_ascii=True))
