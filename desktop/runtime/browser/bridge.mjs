// Hub owns the browser, transport allowlist, network tunnel and session lifetime.
// Playwright MCP supplies the actual accessibility refs and interaction tools.
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import {chromium} from 'playwright';
import {createConnection} from '@playwright/mcp';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const origins=new Set(config.origins);
const allowed=new Set(['browser_navigate','browser_navigate_back','browser_snapshot','browser_click','browser_type','browser_hover','browser_select_option','browser_press_key','browser_tabs','browser_wait_for']);
const sockets=new Set();
const proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
proxy.on('connect',(req,socket,head)=>{
  const match=/^([a-z0-9.-]+):443$/i.exec(req.url??'');
  const host=match?.[1]?.toLowerCase();
  const addresses=config.addresses[host];
  if(!host||!origins.has(`https://${host}`)||!Array.isArray(addresses)||!addresses.length){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  // Addresses are resolved and checked by Hub, then pinned for this session.
  const upstream=net.connect({host:addresses[0],port:443});
  sockets.add(socket);sockets.add(upstream);
  upstream.setTimeout(60_000,()=>upstream.destroy());socket.setTimeout(60_000,()=>socket.destroy());
  upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  upstream.on('close',()=>{sockets.delete(upstream);socket.destroy();});socket.on('close',()=>{sockets.delete(socket);upstream.destroy();});
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:config.executable,headless:true,chromiumSandbox:true,
  proxy:{server:`http://127.0.0.1:${proxy.address().port}`,bypass:'<-loopback>'},
  args:['--disable-quic','--disable-background-networking','--disable-extensions','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1280,height:800}});
const blocked=[];
const permit=raw=>{try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&origins.has(url.origin);}catch{return false;}};
await context.route('**/*',async route=>{
  const request=route.request();
  if(!permit(request.url())||!['GET','HEAD'].includes(request.method())){
    if(blocked.length<10)blocked.push({url:request.url().split('?')[0].slice(0,256),method:request.method()});
    await route.abort('blockedbyclient');return;
  }
  await route.continue();
});
// WebSockets are a separate channel and must not evade HTTP method checks.
await context.routeWebSocket('**/*',socket=>socket.close());
context.on('page',page=>{
  page.on('download',download=>void download.cancel());
  page.on('dialog',dialog=>void dialog.dismiss());
});
const server=await createConnection({capabilities:['core'],imageResponses:'omit',codegen:'none',snapshot:{mode:'full'},
  timeouts:{action:8000,navigation:20000},saveSession:false,allowUnrestrictedFileAccess:false},async()=>context);
const transport=new StdioServerTransport();
const originalSend=transport.send.bind(transport);
const calls=new Map();
transport.send=async message=>{
  if(Array.isArray(message.result?.tools))message={...message,result:{...message.result,tools:message.result.tools.filter(t=>allowed.has(t.name))}};
  if(Array.isArray(message.result?.content)){
    let remaining=30000,truncated=false;
    const content=message.result.content.filter(c=>c.type==='text').map(c=>{
      const text=String(c.text??'').replace(/- \[Snapshot\]\([^\n]+\)/g,'Call browser_snapshot to obtain inline element references.');
      const bytes=Buffer.from(text,'utf8');const value=bytes.subarray(0,remaining).toString('utf8');remaining-=Math.min(bytes.length,remaining);if(bytes.length>Buffer.byteLength(value,'utf8'))truncated=true;return {type:'text',text:value};
    });
    const pages=context.pages().filter(p=>!p.isClosed()).map(p=>p.url()).filter(permit).slice(0,8).map(url=>url.slice(0,2048));
    // Only the page whose inline snapshot was returned is readable evidence.
    // Other open tabs are session metadata, not proof that their content was read.
    const snapshotUrl=calls.get(message.id)==='browser_snapshot'&&!message.result.isError
      ?content.map(c=>c.text.split('### Snapshot')[0].match(/^- Page URL: (https:\/\/\S+)$/m)?.[1]).find(url=>url&&permit(url)&&pages.includes(url))
      :undefined;
    content.push({type:'text',text:JSON.stringify({hubBrowser:{pages,snapshotUrl,blocked:blocked.splice(0),truncated,session:'temporary public browser; GET/HEAD only'}})});
    message={...message,result:{...message.result,content}};
  }
  if('id' in message&&('result' in message||'error' in message))calls.delete(message.id);
  return originalSend(message);
};
await server.connect(transport);
const dispatch=transport.onmessage;
transport.onmessage=message=>{
  if(message.method==='tools/call'){
    const {name,arguments:args={}}=message.params??{};
    let reason;
    if(!allowed.has(name))reason='Tool is outside this browser grant';
    else if(['filename','path','file','code','function','files'].some(key=>key in args))reason='File and script operations are unavailable';
    else if(name==='browser_navigate'&&!permit(args.url))reason='Navigation requires an explicitly authorized HTTPS origin';
    else if(name==='browser_wait_for'&&args.time>5)reason='Wait is limited to five seconds';
    else if(name==='browser_tabs'&&args.action==='new'&&context.pages().length>=8)reason='This session is limited to eight tabs';
    if(reason){void originalSend({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:reason}]}});return;}
    calls.set(message.id,name);
  }
  dispatch(message);
};
let closing=false;
async function close(){if(closing)return;closing=true;for(const socket of sockets)socket.destroy();proxy.close();await browser.close().catch(()=>{});process.exit(0);}
process.stdin.on('end',()=>void close());process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
