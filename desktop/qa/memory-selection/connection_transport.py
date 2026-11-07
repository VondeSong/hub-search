"""Reuse old protocol implementation with per-child isolated Codex home and memory-only auth."""
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace

import latency_transport as legacy
import latency_reuse as legacy_reuse
from connection_support import WORK,HOME,MODEL,EFFORT

legacy.WORK=WORK
legacy_reuse.WORK=WORK
_settings=legacy.settings

def _owned_settings(directory,telemetry,ignore_user=False,telemetry_enabled=False):
    # Child has a new empty home; no user connector entries should be synthesized.
    return _settings(directory,telemetry,ignore_user=True,telemetry_enabled=telemetry_enabled)

def _popen(command,**kwargs):
    child_env=os.environ.copy()
    child_env.update({'CODEX_HOME':str(HOME),'CODEX_SQLITE_HOME':str(WORK/'shared-codex-state'),
                      'TEMP':str(WORK/'tmp'),'TMP':str(WORK/'tmp')})
    for key in ['CODEX_API_KEY','OPENAI_API_KEY','CODEX_ACCESS_TOKEN']:
        child_env.pop(key,None)
    return subprocess.Popen(command,env=child_env,**kwargs)

legacy.settings=_owned_settings
legacy.subprocess=SimpleNamespace(Popen=_popen,PIPE=subprocess.PIPE,CREATE_NO_WINDOW=getattr(subprocess,'CREATE_NO_WINDOW',0),
                                 TimeoutExpired=subprocess.TimeoutExpired)

class Wire(legacy.Wire):
    def __init__(self,directory,mode='app',schema=None,telemetry_enabled=True):
        assert mode=='app'
        self.any_turn_started=False
        super().__init__(directory,mode,schema,telemetry_enabled)
        try:
            # No secrets are written to outgoing protocol logs; legacy send never records requests.
            config_home=self.rpc('config/read',{'includeLayers':False})['config'].get('codex_home')
            # initialize response is the authoritative resolved home (config/read may omit it).
            initial=next(r['event']['result'] for r in self.events if r['event'].get('id')==1)
            assert Path(initial['codexHome']).resolve()==HOME.resolve()
            if config_home:
                assert Path(config_home).resolve()==HOME.resolve()
            auth_path=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
            auth=json.loads(auth_path.read_text(encoding='utf-8'))
            tokens=auth['tokens']
            result=self.rpc('account/login/start',{'type':'chatgptAuthTokens','accessToken':tokens['access_token'],
                                                 'chatgptAccountId':tokens['account_id']})
            assert result['type']=='chatgptAuthTokens'
            assert not (HOME/'auth.json').exists()
            del tokens,auth
        except BaseException:
            self.close()
            raise

    def rpc(self,method,params,timeout=120):
        result=super().rpc(method,params,timeout)
        if method=='turn/start':
            self.any_turn_started=True
        return result

legacy_reuse.Wire=Wire

class ReusableSession(legacy_reuse.ReusableSession):
    def empty_history(self):
        if not self.wire.any_turn_started:
            # Native list APIs reject an unmaterialized new thread. Its actual start
            # response proves the initial empty state; all later checks use the APIs.
            turns=self.setup['thread']['turns']
            assert turns==[]
            return {'proofKind':'initialThreadStart','threadId':self.thread,
                    'turns':{'data':turns},'items':{'data':[]}}
        return {'proofKind':'nativeHistoryLists',**super().empty_history()}

def secret_scan():
    auth_path=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
    data=json.loads(auth_path.read_text(encoding='utf-8')).get('tokens',{})
    needles=[v.encode() for k,v in data.items() if k in ['access_token','refresh_token','id_token'] and isinstance(v,str) and len(v)>30]
    leaked=[]
    for path in WORK.rglob('*'):
        if path.is_file():
            blob=path.read_bytes()
            if any(n in blob for n in needles):
                leaked.append(str(path.relative_to(WORK)))
    return {'credentialPersisted':bool(leaked),'files':leaked,'authFileCopied':(HOME/'auth.json').exists()}
