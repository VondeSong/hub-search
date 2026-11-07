"""Timestamp real CLI/app-server boundaries; local allowlisted OTel, no TLS interception."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import tomllib

import psutil

from latency_support import WORK, MODEL, EFFORT, digest
from passage_model import BASE, CODEX, DISABLED


def write(path, value):
    with Path(path).open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')


class Telemetry:
    """Persist timing-only attributes. Auth, prompts, error text, resources never persist."""
    ALLOW = {'event.name','event_name','event','model','reasoning_effort','conversation.id',
             'conversation_id','thread_id','turn_id','request_id','duration_ms','kind','status',
             'success','attempt','input_token_count','output_token_count','cached_token_count',
             'reasoning_token_count','input_tokens','output_tokens','reasoning_tokens',
             'http.status_code','http.response.status_code','latency_ms','time_to_first_token_ms',
             'event.timestamp','event.kind','startup.phase','startup.status','auth.connection_reused'}

    def __init__(self, directory):
        self.directory = directory
        self.rows = []
        self.lock = threading.Lock()
        self.started = time.perf_counter()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                count = int(self.headers.get('Content-Length', '0'))
                if count > 4_000_000:
                    self.send_error(413)
                    return
                try:
                    value = json.loads(self.rfile.read(count))
                    owner.consume(value)
                except (ValueError, KeyError):
                    self.send_error(400)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{}')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def consume(self, value):
        for resource in value.get('resourceLogs', []):
            for scope in resource.get('scopeLogs', []):
                for record in scope.get('logRecords', []):
                    attrs = record.get('attributes', [])
                    row = {'observedMs': (time.perf_counter()-self.started)*1000,
                           'timeUnixNano': record.get('timeUnixNano'),
                           'attributeNames': [a['key'] for a in attrs]}
                    body = (record.get('body') or {}).get('stringValue', '')
                    if re.fullmatch(r'codex\.[a-zA-Z0-9_.]+', body):
                        row['eventName'] = body
                    for a in attrs:
                        if a['key'] in self.ALLOW:
                            v = a.get('value', {})
                            simple = next((v[k] for k in ['stringValue','intValue','doubleValue','boolValue'] if k in v), None)
                            if isinstance(simple, (str, int, float, bool)):
                                row[a['key']] = simple
                    with self.lock:
                        self.rows.append(row)

    @property
    def config(self):
        port = self.server.server_port
        return ['-c', 'otel.log_user_prompt=false', '-c', 'otel.metrics_exporter="none"',
                '-c', 'otel.trace_exporter="none"', '-c', 'analytics.enabled=false',
                '-c', 'otel.exporter={otlp-http={endpoint="http://127.0.0.1:'+str(port)+'/v1/logs",protocol="json"}}']

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        write(self.directory/'telemetry.json', self.rows)


def settings(directory, telemetry, ignore_user=False, telemetry_enabled=False):
    base = directory/'base.md'
    base.write_text(BASE, encoding='utf-8')
    config = ['-c', 'model='+json.dumps(MODEL), '-c', 'model_reasoning_effort="'+EFFORT+'"',
              '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
              '-c', 'notify=[]', '-c', 'service_tier="default"',
              '-c', 'model_reasoning_summary="none"',
              '-c', 'model_instructions_file='+json.dumps(base.as_posix()),
              '-c', 'log_dir='+json.dumps((directory/'logs').as_posix()),
              '-c', 'sqlite_home='+json.dumps((WORK/'shared-codex-state').as_posix())]
    # app-server has no --ignore-user-config. Disable named connectors without logging their config.
    user = Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'config.toml'
    names = list(tomllib.loads(user.read_text(encoding='utf-8')).get('mcp_servers', {})) if user.exists() and not ignore_user else []
    for name in names:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
            raise ValueError('Connector key requires unsupported quoting; do not start')
        config += ['-c', 'mcp_servers.'+name+'.enabled=false']
    for feature in DISABLED:
        config += ['--disable', feature]
    config += ['--enable', 'skip_host_skill_discovery']
    return config + (telemetry.config if telemetry_enabled else ['-c','otel.exporter="none"',
        '-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"','-c','analytics.enabled=false'])


def owned_stop(process, create_time):
    if process.poll() is None:
        try:
            parent = psutil.Process(process.pid)
            assert parent.create_time() == create_time
            members = [*parent.children(recursive=True), parent]
            for member in members:
                try:
                    member.terminate()
                except psutil.NoSuchProcess:
                    pass
            _, alive = psutil.wait_procs(members, timeout=5)
            for member in alive:
                member.kill()
        except psutil.NoSuchProcess:
            pass
        process.wait(timeout=10)


class Wire:
    def __init__(self, directory, mode, schema=None, telemetry_enabled=False):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=False)
        self.telemetry = Telemetry(directory)
        self.queue = queue.Queue(maxsize=20000)
        self.events = []
        self.sockets = []
        self.pending = []
        self.counter = 0
        self.closed = False
        self.began = time.perf_counter()
        self.began_unix_ns = time.time_ns()
        self.mode = mode
        self.error = (directory/'stderr.log').open('wb')
        if schema is not None:
            write(directory/'schema.json',schema)
        cmd = [str(CODEX)]
        if mode == 'cli':
            cmd += ['exec','--ignore-user-config','--ephemeral','--json','--skip-git-repo-check',
                    '--sandbox','read-only','--color','never','--output-schema',str(directory/'schema.json'),
                    '--output-last-message',str(directory/'output.json')]
        else:
            cmd += ['app-server','--listen','stdio://']
        cmd += settings(directory, self.telemetry, ignore_user=mode=='cli',telemetry_enabled=telemetry_enabled)
        if mode == 'cli':
            cmd += ['-']
        self.process = subprocess.Popen(cmd, cwd=directory, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.error,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.create_time = psutil.Process(self.process.pid).create_time()
        self.spawn_ms = (time.perf_counter()-self.began)*1000
        write(directory/'process.json', {'pid':self.process.pid,'createTime':self.create_time,
              'mode':mode,'model':MODEL,'effort':EFFORT,'spawnReturnedMs':self.spawn_ms,
              'beganUnixNs':self.began_unix_ns})
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.stop_sampling = threading.Event()
        # Windows connection enumeration blocked for ~40s in preflight-v2.
        # Do not put that observer on the measured path; OTel establishes transport.
        self.sampler = None
        if mode != 'cli':
            try:
                self.rpc('initialize', {'clientInfo':{'name':'hub_hbm_latency','title':'HBM-00 isolated','version':'1.0'},
                                       'capabilities':{'experimentalApi':True}}, timeout=60)
                self.send({'method':'initialized','params':{}})
                self.initialize_ms = (time.perf_counter()-self.began)*1000
            except BaseException:
                self.close()
                raise

    def _read(self):
        try:
            with (self.directory/'protocol.jsonl').open('x',encoding='utf-8') as log:
                for line in self.process.stdout:
                    stamp = (time.perf_counter()-self.began)*1000
                    event = json.loads(line.decode('utf-8'))
                    row = {'ms':stamp,'event':event}
                    self.events.append(row)
                    log.write(json.dumps(row,ensure_ascii=False)+'\n')
                    log.flush()
                    self.queue.put(row, timeout=2)
        except BaseException as error:
            self.queue.put({'readerError':type(error).__name__})
        finally:
            self.queue.put({'eof':True})

    def _sockets(self):
        last = None
        while not self.stop_sampling.wait(.1):
            try:
                p = psutil.Process(self.process.pid)
                current = sorted((c.laddr.port, hashlib.sha256((c.raddr.ip+':'+str(c.raddr.port)).encode()).hexdigest()[:12],c.status)
                                 for c in p.net_connections(kind='tcp') if c.raddr)
                if current != last:
                    self.sockets.append({'ms':(time.perf_counter()-self.began)*1000,'connections':current})
                    last = current
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                break

    def send(self, event):
        self.process.stdin.write((json.dumps(event,ensure_ascii=False)+'\n').encode())
        self.process.stdin.flush()

    def next(self, deadline):
        row = self.queue.get(timeout=max(.001,deadline-time.monotonic()))
        if 'eof' in row or 'readerError' in row:
            raise RuntimeError('Protocol reader ended before completion')
        if row['event'].get('method','').endswith('requestApproval'):
            raise RuntimeError('Tool-free call attempted approval')
        return row

    def rpc(self, method, params, timeout=120):
        self.counter += 1
        ident = self.counter
        self.send({'id':ident,'method':method,'params':params})
        deadline = time.monotonic()+timeout
        while True:
            row = self.next(deadline)
            msg = row['event']
            if msg.get('id')==ident:
                if 'error' in msg:
                    raise RuntimeError('RPC '+method+' rejected: '+json.dumps(msg['error'],ensure_ascii=False))
                return msg['result']
            self.pending.append(row)

    def start_thread(self):
        start = time.perf_counter()
        result = self.rpc('thread/start', {'model':MODEL,'allowProviderModelFallback':False,
            'cwd':str(self.directory),'ephemeral':True,'sandbox':'read-only','approvalPolicy':'never',
            'baseInstructions':BASE,'developerInstructions':'','dynamicTools':[],
            'config':{'model_reasoning_effort':EFFORT},'serviceTier':'default'})
        assert result['model']==MODEL and result['reasoningEffort']==EFFORT
        thread = result['thread']
        assert thread['ephemeral'] and thread['turns']==[]
        return thread['id'], (time.perf_counter()-start)*1000, result

    def app_call(self, prompt, schema, directory):
        began = time.perf_counter()
        directory.mkdir(parents=True,exist_ok=False)
        (directory/'input.txt').write_text(prompt,encoding='utf-8')
        write(directory/'schema.json',schema)
        thread, thread_ms, setup = self.start_thread()
        offset = (time.perf_counter()-self.began)*1000
        response = self.rpc('turn/start', {'threadId':thread,'model':MODEL,'effort':EFFORT,
            'summary':'none','input':[{'type':'text','text':prompt}], 'outputSchema':schema,
            'approvalPolicy':'never','sandboxPolicy':{'type':'readOnly'},'serviceTierForTurn':'default'})
        turn_id = response['turn']['id']
        deadline = time.monotonic()+120
        rows = self.pending
        self.pending = []
        used = []
        completed = None
        while completed is None:
            if rows:
                row = rows.pop(0)
            else:
                row = self.next(deadline)
            event = row['event']
            params = event.get('params',{})
            if params.get('threadId')!=thread:
                continue
            used.append(row)
            if event.get('method')=='error':
                raise RuntimeError('Model turn error; retained in protocol')
            item = params.get('item',{})
            if item.get('type') not in [None,'userMessage','agentMessage','reasoning']:
                raise RuntimeError('Unexpected non-text item '+str(item.get('type')))
            if event.get('method')=='turn/completed' and params['turn']['id']==turn_id:
                completed=params['turn']
                assert completed['status']=='completed' and not completed.get('error')
        texts=[r['event']['params']['item']['text'] for r in used
               if r['event'].get('method')=='item/completed' and r['event']['params'].get('item',{}).get('type')=='agentMessage']
        assert len(texts)==1
        answer=json.loads(texts[0])
        write(directory/'output.json',answer)
        first=lambda predicate:next((r['ms']-offset for r in used if predicate(r['event'])),None)
        usage=[r['event']['params']['tokenUsage']['last'] for r in used if r['event'].get('method')=='thread/tokenUsage/updated']
        receipt={'status':'completed','model':MODEL,'effort':EFFORT,'mode':'app-server',
            'pid':self.process.pid,'createTime':self.create_time,'threadId':thread,'turnId':turn_id,
            'ephemeral':True,'freshEmptyHistory':True,'threadSetupMs':thread_ms,
            'submitToTurnStartedMs':first(lambda e:e.get('method')=='turn/started'),
            'submitToFirstReasoningItemMs':first(lambda e:e.get('method')=='item/started' and e['params'].get('item',{}).get('type')=='reasoning'),
            'submitToFirstAnswerDeltaMs':first(lambda e:e.get('method')=='item/agentMessage/delta'),
            'submitToCompletionMs':used[-1]['ms']-offset,
            'serverTurnDurationMs':completed.get('durationMs'),
            'usage':usage[-1] if usage else None,'explicitRetries':0,'toolCalls':0,
            'inputSha256':digest(directory/'input.txt'),'outputSha256':digest(directory/'output.json'),
            'baseInstructionsSha256':hashlib.sha256(BASE.encode()).hexdigest(),
            'modelAndHostMs':(time.perf_counter()-began)*1000}
        receipt['unsubscribe']=self.rpc('thread/unsubscribe',{'threadId':thread})
        receipt['durationMs']=(time.perf_counter()-began)*1000
        write(directory/'thread-start.json',setup)
        write(directory/'events.json',used)
        write(directory/'receipt.json',receipt)
        return answer, receipt

    def cli_call(self, prompt, schema):
        # Schema must exist before CLI opens it; the process waits on stdin for prompt.
        assert json.loads((self.directory/'schema.json').read_text(encoding='utf-8'))==schema
        (self.directory/'input.txt').write_text(prompt,encoding='utf-8')
        self.process.stdin.write(prompt.encode())
        self.process.stdin.close()
        deadline=time.monotonic()+120
        used=[]
        completed=None
        while completed is None:
            row=self.next(deadline)
            used.append(row)
            if row['event'].get('type')=='turn.completed':
                completed=row['event']
        self.process.wait(timeout=10)
        assert self.process.returncode==0
        answer=json.loads((self.directory/'output.json').read_text(encoding='utf-8'))
        first=lambda kind:next((r['ms'] for r in used if r['event'].get('type')==kind),None)
        receipt={'status':'completed','model':MODEL,'effort':EFFORT,'mode':'cli',
            'pid':self.process.pid,'createTime':self.create_time,'ephemeral':True,'freshEmptyHistory':True,
            'spawnReturnedMs':self.spawn_ms,'spawnToThreadStartedMs':first('thread.started'),
            'spawnToTurnStartedMs':first('turn.started'),
            'spawnToCompletionMs':first('turn.completed'),'usage':completed.get('usage'),
            'explicitRetries':0,'toolCalls':0,'inputSha256':digest(self.directory/'input.txt'),
            'outputSha256':digest(self.directory/'output.json'),
            'modelAndHostMs':(time.perf_counter()-self.began)*1000}
        assert not any(r['event'].get('item',{}).get('type') in ['command_execution','mcp_tool_call','web_search'] for r in used)
        write(self.directory/'receipt.json',receipt)
        return answer,receipt

    def close(self):
        if self.closed:
            return
        self.closed=True
        if self.process.poll() is None and not self.process.stdin.closed:
            self.process.stdin.close()
        normal=True
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            normal=False
            owned_stop(self.process,self.create_time)
        self.stop_sampling.set()
        if self.sampler:
            self.sampler.join(timeout=2)
        self.reader.join(timeout=2)
        self.error.close()
        self.telemetry.close()
        write(self.directory/'protocol.json',self.events)
        write(self.directory/'connections.json',self.sockets)
        write(self.directory/'exit.json',{'normal':normal,'exitCode':self.process.returncode,
            'pid':self.process.pid,'createTime':self.create_time,'readerExited':not self.reader.is_alive(),
            'initializeMs':getattr(self,'initialize_ms',None),'totalMs':(time.perf_counter()-self.began)*1000})
