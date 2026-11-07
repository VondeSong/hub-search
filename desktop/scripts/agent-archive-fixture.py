"""An observable wire fixture; never impersonates a live Craft account."""
import json,uuid,threading,re,html,time,socket,argparse
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
parser=argparse.ArgumentParser(description="Craft protocol fixture for isolated desktop Agent acceptance")
parser.add_argument('--state-root',type=Path,required=True)
args=parser.parse_args()
S=args.state_root.resolve()
S.mkdir(parents=True,exist_ok=True)
CARRIER='a0000000-0000-4000-8000-000000000001'
FOLDER='a0000000-0000-4000-8000-000000000002'
MEDIA=b'Hub synthetic video fixture; do not analyze.'
state={'format':'hub-craft-wire-fixture-v1','pages':{},'requests':[],'creates':0,'bodyWrites':0,'uploads':0}
if (S/'craft-wire.json').exists():
 prior=json.loads((S/'craft-wire.json').read_text(encoding='utf-8'))
 assert prior.get('format')==state['format'],'Unowned fixture state'
 state=prior
lock=threading.RLock()
def save():
 path=S/'craft-wire.json';temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)
def mode():
 path=S/'craft-fault.json'
 return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def reply(self,data,status=200,kind='application/json'):
  data=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False).encode('utf-8')
  self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def handle_request(self):
  url=urlparse(self.path);route=url.path.rsplit('/api/v1/',1)[-1];query=parse_qs(url.query)
  raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
  body=json.loads(raw) if raw and self.headers.get('Content-Type','').startswith('application/json') else None
  with lock:
   state['requests'].append({'method':self.command,'route':url.path,'query':query,'body':body,'bytes':len(raw),'at':time.time()});save()
   if url.path=='/media/fixture.mp4':return self.reply(MEDIA,kind='video/mp4')
   if self.command=='GET':
    if route=='connection':return self.reply({'space':{'id':'agent-acceptance-craft','name':'归档验收（本机模拟服务）'}})
    if route=='folders':return self.reply({'items':[{'id':FOLDER,'name':'实验记录'}]})
    if route=='documents':return self.reply({'items':[{'id':CARRIER,'title':'装配验证记录','folderId':FOLDER}]})
    if route=='blocks':
     id=query.get('id',[''])[0]
     if id==CARRIER:return self.reply({'id':CARRIER,'type':'page','title':'装配验证记录','content':[{'id':'a0000000-0000-4000-8000-000000000003','type':'text','markdown':'这里记录孔距测量、配合公差、装配前验证条件，保存未验证事项。'}]})
     if id in state['pages']:
      page=state['pages'][id]
      content=[{'id':str(uuid.uuid5(uuid.NAMESPACE_URL,id+':body')),'type':'text','markdown':page['body']}]+page['attachments']
      if mode().get('fault')=='hide-body':content=[]
      return self.reply({'id':id,'type':'page','title':page['title'],'content':content})
     return self.reply({'error':'unknown fixture object'},404)
   if self.command=='POST' and route in ['documents','blocks']:
    markdown=(body or {}).get('markdown','')
    creating=route=='documents' or markdown.startswith('<page>')
    if creating:
     title=body['documents'][0]['title'] if route=='documents' else html.unescape(re.search(r'<pageTitle>(.*?)</pageTitle>',markdown,re.S).group(1))
     id=str(uuid.uuid4());state['pages'][id]={'title':title,'body':'','attachments':[],'position':body.get('position',body.get('destination'))};state['creates']+=1;save()
     if mode().get('fault')=='lose-create-response':
      (S/'craft-fault.json').write_text('{}',encoding='utf-8');self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
     return self.reply({'items':[{'id':id,'type':'page'}]})
    id=body.get('position',{}).get('pageId');assert id in state['pages'],body
    state['pages'][id]['body']+=markdown;state['bodyWrites']+=1;save();return self.reply({'items':[{'id':str(uuid.uuid4()),'type':'text'}]})
   if self.command=='POST' and route=='upload':
    id=query['pageId'][0];assert raw==MEDIA,'Unexpected fixture attachment bytes'
    block=str(uuid.uuid4());state['pages'][id]['attachments'].append({'id':block,'type':'video','url':'https://example.com/fixture-uploaded.mp4'});state['uploads']+=1;save();return self.reply({'blockId':block,'assetUrl':'https://example.com/fixture-uploaded.mp4'})
   if self.command=='PUT' and route=='documents/move':return self.reply({'items':[]})
   self.reply({'error':'unsupported fixture route'},404)
 def do_GET(self):self.handle_request()
 def do_POST(self):self.handle_request()
 def do_PUT(self):self.handle_request()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
url=f'http://127.0.0.1:{server.server_address[1]}/links/agent-acceptance/api/v1'
(S/'craft-endpoint.json').write_text(json.dumps({'apiUrl':url,'format':'hub-agent-desktop-acceptance-v1'}),encoding='utf-8');save()
print(json.dumps({'endpoint':url,'fixture':'synthetic local server; no real Craft account'}),flush=True)
server.serve_forever(poll_interval=.25)
