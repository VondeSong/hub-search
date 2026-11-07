"""Admission diagnosis with bounded allowlisted error metadata; never log tokens."""
import base64
import json
import os
from pathlib import Path
import re
import time
import urllib.request
import urllib.error
from websockets.sync.client import connect
from accounting_support import save,read

def safe_body(blob,secrets):
    try:
        value=json.loads(blob)
    except (ValueError,UnicodeDecodeError):
        return {'shape':'non-json','bytes':len(blob)}
    result={'shape':list(value) if isinstance(value,dict) else type(value).__name__}
    if not isinstance(value,dict):
        return result
    error=value.get('error',{})
    if isinstance(error,dict):
        for key in ['code','type','param']:
            v=error.get(key)
            if isinstance(v,str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}',v) and not any(s in v for s in secrets):
                result[key]=v
    texts=[value.get('detail',''),error.get('message','') if isinstance(error,dict) else error if isinstance(error,str) else '']
    text=' '.join(x for x in texts if isinstance(x,str)).lower()
    result['signals']=[label for label,words in {
        'missing_permission':['scope','permission','not authorized'],
        'invalid_credential':['invalid token','invalid api key','incorrect api key','invalid authentication'],
        'missing_signed_identity':['signed identity','signature','identity context'],
        'region_policy':['country','region','territory'],
        'unsupported_route':['route not supported','route_not_supported','method not allowed'],
        'expired':['expired'],
    }.items() if any(word in text for word in words)]
    # Known diagnostic text may still reflect a credential. Strip all known values,
    # JWT-like strings, emails and long opaque identifiers before any persistence.
    for secret in secrets:
        if secret:
            text=text.replace(secret.lower(),'[redacted]')
    text=re.sub(r'\beyj[a-z0-9_.-]+','[redacted-jwt]',text,flags=re.I)
    text=re.sub(r'[\w.+-]+@[\w.-]+','[redacted-email]',text)
    text=re.sub(r'[a-zA-Z0-9_-]{25,}','[redacted-opaque]',text)
    result['redactedDiagnostic']=text[:600]
    return result

if __name__=='__main__':
    read('scope-contract.json')
    path=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
    data=json.loads(path.read_text(encoding='utf-8'))['tokens']
    secrets=[v for k,v in data.items() if k in ['access_token','refresh_token','id_token'] and isinstance(v,str)]
    token=data['access_token']
    payload=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='))
    scopes=payload.get('scope',payload.get('scp'))
    scopes=scopes.split() if isinstance(scopes,str) else scopes
    auth={'decodedClaimsSignatureVerified':False,'scopeClaimPresent':isinstance(scopes,list),
          'hasDirectPlanScope':'chatgpt.tokens.use.direct' in scopes if isinstance(scopes,list) else None,
          'hasResourceInvoke':'resource.invoke' in scopes if isinstance(scopes,list) else None,
          'expired':payload.get('exp',0)<time.time(),
          'publicApiAudience':'https://api.openai.com/v1' in str(payload.get('aud','')),
          'valuesNotPersisted':['access token','refresh token','ID token','identity/account claims']}
    rows=[]
    start=time.perf_counter()
    request=urllib.request.Request('https://api.openai.com/v1/models',headers={'Authorization':'Bearer '+token})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            rows.append({'route':'GET /v1/models','status':response.status,'durationMs':(time.perf_counter()-start)*1000})
    except urllib.error.HTTPError as error:
        rows.append({'route':'GET /v1/models','status':error.code,'requestId':error.headers.get('x-request-id'),
                     'body':safe_body(error.read(16384),secrets),'durationMs':(time.perf_counter()-start)*1000})
        error.close()
    start=time.perf_counter()
    try:
        socket=connect('wss://api.openai.com/v1/responses',additional_headers={'Authorization':'Bearer '+token},open_timeout=30,close_timeout=3)
        socket.close()
        rows.append({'route':'WS upgrade /v1/responses','status':101,'noResponseCreateSent':True,'durationMs':(time.perf_counter()-start)*1000})
    except Exception as error:
        response=getattr(error,'response',None)
        rows.append({'route':'WS upgrade /v1/responses','status':getattr(response,'status_code',None),
            'errorType':type(error).__name__,'body':safe_body(bytes(getattr(response,'body',b'')),secrets) if response else {},
            'requestId':response.headers.get('x-request-id') if response else None,'noResponseCreateSent':True,
            'durationMs':(time.perf_counter()-start)*1000})
    assert all(r.get('requestId') is None or re.fullmatch(r'[A-Za-z0-9_:-]{1,150}',r['requestId']) for r in rows)
    save('public-admission-v2.json',{'authMetadata':auth,'requests':rows,'inferenceRequests':0,
        'rule':'Do not send inference without direct scope/resource grant. Existing native Codex authentication is a separate supported path.',
        'sources':['https://developers.openai.com/siwc/token-sharing-open-source/sign-in','https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery'],
        'newOAuthConsentOrBillingFallback':False})
    print(json.dumps({'auth':auth,'requests':rows},ensure_ascii=True))
