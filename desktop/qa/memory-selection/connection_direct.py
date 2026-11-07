"""Public Responses WebSocket, full independent request each time, same ChatGPT-plan OAuth."""
import json
import os
from pathlib import Path
import threading
import time
import uuid

from websockets.sync.client import connect

from connection_support import WORK,MODEL,EFFORT,digest
from latency_transport import write
from passage_model import BASE


class Direct:
    def __init__(self,name):
        self.directory=WORK/name
        self.directory.mkdir(parents=True,exist_ok=False)
        self.connection_id=str(uuid.uuid4())
        self.calls=0
        self.closed=False
        auth_path=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
        token=json.loads(auth_path.read_text(encoding='utf-8'))['tokens']['access_token']
        began=time.perf_counter()
        try:
            self.socket=connect('wss://api.openai.com/v1/responses',additional_headers={'Authorization':'Bearer '+token},
                open_timeout=30,close_timeout=5,max_size=8_000_000,ping_interval=20,ping_timeout=20)
        except BaseException as error:
            response=getattr(error,'response',None)
            write(self.directory/'connection.json',{'status':'failed','errorType':type(error).__name__,
                'httpStatus':getattr(response,'status_code',None),'endpoint':'wss://api.openai.com/v1/responses',
                'durationMs':(time.perf_counter()-began)*1000,'credentialPersisted':False})
            raise RuntimeError('Public ChatGPT-plan WebSocket unavailable; no private endpoint or API-key fallback') from None
        finally:
            del token
        self.initialize_ms=(time.perf_counter()-began)*1000
        write(self.directory/'connection.json',{'status':'connected','connectionId':self.connection_id,
            'endpoint':'wss://api.openai.com/v1/responses','initializeMs':self.initialize_ms,
            'authentication':'Existing ChatGPT-plan OAuth bearer, memory only','reconnects':0})

    def call(self,prompt,schema,directory):
        began=time.perf_counter()
        directory.mkdir(parents=True,exist_ok=False)
        (directory/'input.txt').write_text(prompt,encoding='utf-8')
        request={'type':'response.create','model':MODEL,'store':False,'service_tier':'default',
            'instructions':BASE,'input':[{'type':'message','role':'user','content':[{'type':'input_text','text':prompt}]}],
            'reasoning':{'effort':EFFORT},'tools':[],
            'text':{'format':{'type':'json_schema','name':'memory_applicability','strict':True,'schema':schema}}}
        assert 'previous_response_id' not in request and 'conversation' not in request
        write(directory/'wire-request.json',request)
        self.calls+=1
        send_began=time.perf_counter()
        self.socket.send(json.dumps(request,ensure_ascii=False))
        sent=time.perf_counter()
        stop_probe=threading.Event()
        heartbeat=[]
        def probe():
            if stop_probe.is_set():
                return
            stamp=time.perf_counter()
            try:
                pong=self.socket.ping()
                alive=pong.wait(timeout=3)
                heartbeat.append({'atMs':(stamp-sent)*1000,'pongWithin3Seconds':alive,
                                  'roundTripMs':(time.perf_counter()-stamp)*1000})
            except BaseException as error:
                heartbeat.append({'atMs':(stamp-sent)*1000,'errorType':type(error).__name__})
        timer=threading.Timer(15,probe)
        timer.daemon=True
        timer.start()
        frames=[]
        complete=None
        first_answer=created=None
        response_id=None
        deadline=time.monotonic()+120
        try:
            with (directory/'events.jsonl').open('x',encoding='utf-8') as log:
                while complete is None:
                    event=json.loads(self.socket.recv(timeout=max(.001,deadline-time.monotonic())))
                    elapsed=(time.perf_counter()-sent)*1000
                    row={'ms':elapsed,'event':event}
                    log.write(json.dumps(row,ensure_ascii=False)+'\n');log.flush()
                    frames.append(row)
                    kind=event.get('type')
                    if kind in ['error','response.failed','response.incomplete']:
                        write(directory/'failure.json',{'eventType':kind,'errorCode':event.get('error',{}).get('code'),
                                                       'elapsedMs':elapsed})
                        raise RuntimeError('Public response failed; no retry, raw source retained')
                    if kind=='response.created':
                        assert created is None
                        created=elapsed
                        response_id=event['response']['id']
                    if event.get('response_id') and response_id:
                        assert event['response_id']==response_id
                    if kind=='response.output_text.delta' and first_answer is None:
                        first_answer=elapsed
                    if kind=='response.completed':
                        complete=event['response']
                        assert complete['status']=='completed' and complete['id']==response_id
            assert complete['model'].startswith(MODEL)
            assert complete.get('reasoning',{}).get('effort')==EFFORT
            texts=[]
            for item in complete['output']:
                assert item['type'] in ['message','reasoning']
                if item['type']=='message':
                    texts.extend(c['text'] for c in item['content'] if c['type']=='output_text')
            assert len(texts)==1
            answer=json.loads(texts[0])
            write(directory/'output.json',answer)
            receipt={'status':'completed','model':MODEL,'effort':EFFORT,'actualModel':complete['model'],
                'mode':'direct-stateless-ws','connectionId':self.connection_id,'connectionUseNumber':self.calls,
                'reusedConnection':self.calls>1,'freshEmptyHistory':True,'previousResponseIdSent':False,
                'serverStored':False,'sendMs':(sent-send_began)*1000,'sendToCreatedMs':created,
                'sendToFirstAnswerMs':first_answer,'sendToCompletionMs':frames[-1]['ms'],
                'createdToFirstAnswerMs':first_answer-created if first_answer is not None and created is not None else None,
                'maxFrameGapMs':max(b['ms']-a['ms'] for a,b in zip(frames,frames[1:])),
                'heartbeatAt15Seconds':heartbeat,'usage':complete.get('usage'),
                'explicitRetries':0,'toolCalls':0,'inputSha256':digest(directory/'input.txt'),
                'outputSha256':digest(directory/'output.json'),'wireRequestSha256':digest(directory/'wire-request.json'),
                'durationMs':(time.perf_counter()-began)*1000}
            write(directory/'receipt.json',receipt)
            return answer,receipt
        finally:
            stop_probe.set();timer.cancel();timer.join(timeout=4)

    def close(self):
        if not self.closed:
            self.closed=True
            self.socket.close()
            write(self.directory/'exit.json',{'status':'closed','connectionId':self.connection_id,'calls':self.calls,'reconnects':0})
