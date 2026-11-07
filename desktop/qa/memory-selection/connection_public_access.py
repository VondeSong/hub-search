"""Safe public-endpoint eligibility check; no inference or credential persistence."""
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error
from connection_support import save

if __name__=='__main__':
    auth_path=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
    token=json.loads(auth_path.read_text(encoding='utf-8'))['tokens']['access_token']
    request=urllib.request.Request('https://api.openai.com/v1/models',headers={'Authorization':'Bearer '+token})
    began=time.perf_counter()
    result={'endpoint':'https://api.openai.com/v1/models','inferenceCalls':0,'credentialPersisted':False}
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            value=json.loads(response.read())
            result.update({'status':response.status,'modelCount':len(value.get('models',value.get('data',[])))})
    except urllib.error.HTTPError as error:
        result.update({'status':error.code,'errorType':'HTTPError'})
        error.close()
    except Exception as error:
        result.update({'status':None,'errorType':type(error).__name__})
    del request,token
    result['durationMs']=(time.perf_counter()-began)*1000
    save('public-access.json',result)
    print(json.dumps(result))
