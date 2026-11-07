import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

export type McpGrant={server:string;catalogSha256:string;tools:string[];resourceUris?:string[];trustedReadOnly?:boolean};
type Catalog={server:string;title:string;endpoint:string;catalogSha256:string;tools:{name:string;title?:string}[];resources?:{uri:string;name:string}[];blockedToolCount:number;custom?:boolean};
type Service={server:string;title:string;endpoint:string;custom?:boolean};
const services:Service[]=[
  {server:"openai_docs",title:"OpenAI 官方文档",endpoint:"https://developers.openai.com/mcp"},
  {server:"context7",title:"Context7 开发文档",endpoint:"https://mcp.context7.com/mcp"},
];
type Props={value:McpGrant[];disabled:boolean;onChange:(value:McpGrant[])=>void};
export function AgentMcpServices(props:Props) {
  const [address,setAddress]=useState("");
  const [added,setAdded]=useState<string[]>(()=>props.value.filter(g=>g.server.startsWith("https://")).map(g=>g.server));
  const [error,setError]=useState("");
  const custom=[...new Set([...added,...props.value.filter(g=>g.server.startsWith("https://")).map(g=>g.server)])];
  function add() {
    if(props.disabled)return;
    try {
      const url=new URL(address.trim());const host=url.hostname;
      if(url.protocol!=="https:" || url.username || url.password || url.port || url.search || url.hash || url.href.length>2048
        || !host.includes(".") || host.endsWith(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":"))throw new Error("请输入公开域名的 HTTPS 地址，不含登录信息、端口、查询参数或片段。");
      if(services.some(s=>s.endpoint===url.href) || custom.includes(url.href))throw new Error("此服务已在列表中，请使用已有入口。");
      if(custom.length>=8)throw new Error("本对话最多添加 8 个自定义服务。");
      setAdded(current=>[...current,url.href]);setAddress("");setError("");
    } catch(reason) {setError(reason instanceof TypeError?"地址格式无效，请输入完整的 HTTPS 地址。":String((reason as Error).message));}
  }
  function remove(server:string) {
    setAdded(current=>current.filter(s=>s!==server));props.onChange(props.value.filter(g=>g.server!==server));
  }
  return <>
    {services.map(service=><ServiceTools key={service.server} service={service} {...props}/>)}
    <fieldset className="agent-mcp-service" disabled={props.disabled}>
      <legend>添加远程 MCP 服务</legend>
      <p className="agent-note">支持无需登录的远程服务。地址与选择仅保存到本对话，选择后还需应用。不要填写带有密钥的地址。</p>
      <label>远程 MCP 地址<input type="url" value={address} placeholder="https://服务域名/mcp" onChange={e=>setAddress(e.target.value)} onKeyDown={e=>{if(e.key==="Enter" && !e.nativeEvent.isComposing){e.preventDefault();add();}}}/></label>
      <button type="button" onClick={add} disabled={!address.trim()}>添加服务</button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
    {custom.map(endpoint=><ServiceTools key={endpoint} service={{server:endpoint,title:endpoint.split("/")[2]||endpoint,endpoint,custom:true}} {...props} onRemove={()=>remove(endpoint)}/>)}
  </>;
}
function ServiceTools({service,value,disabled,onChange,onRemove}:Props&{service:Service;onRemove?:()=>void}) {
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const grant=value.find(g=>g.server===service.server);
  const [trusted,setTrusted]=useState(!!grant?.trustedReadOnly);
  const selected=grant?.catalogSha256===catalog?.catalogSha256?grant?.tools??[]:[];
  const selectedResources=grant?.catalogSha256===catalog?.catalogSha256?grant?.resourceUris??[]:[];
  async function discover() {
    setLoading(true);setError("");setCatalog(null);
    try {const result=await invoke<Catalog>("agent_investigation",{args:{action:"discoverMcpService",server:service.server}});if(result.server!==service.server)throw new Error("返回的服务身份不一致，请重新发现。");if(alive.current)setCatalog(result);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally {if(alive.current)setLoading(false);}
  }
  function update(grant?:McpGrant) {
    onChange([...value.filter(g=>g.server!==service.server),...(grant?[grant]:[])]);
  }
  function select(name:string,enabled:boolean,resource=false) {
    if(!catalog || disabled || loading || (service.custom && !trusted))return;
    const old=resource?selectedResources:selected;
    const next=enabled?[...old,name]:old.filter(t=>t!==name);
    const tools=resource?selected:next;
    const resourceUris=resource?next:selectedResources;
    update(tools.length||resourceUris.length?{server:catalog.server,catalogSha256:catalog.catalogSha256,tools,...(resourceUris.length?{resourceUris}:{}),...(service.custom?{trustedReadOnly:true}:{})}:undefined);
  }
  return <fieldset className="agent-mcp-service" disabled={disabled||loading}>
    <legend>外部 MCP 服务 · {service.title}</legend>
    <p className="agent-note">{service.endpoint}</p>
    <p className="agent-note">无需登录，用于公开资料查询。调用参数会发送给此服务；这不授予发送私密正文或凭据的权限。只作用于本对话，勾选后还需应用。返回内容作为外部资料，不能替代原文核验或保存授权。</p>
    {service.custom && <>
      <p className="agent-note">仅列出声明为只读、非破坏性的工具。这是服务方的声明，Hub 无法保证远端实现没有写入行为。请只连接你信任的服务。</p>
      <label><input type="checkbox" checked={trusted} onChange={e=>{setTrusted(e.target.checked);if(!e.target.checked)update();}}/>我信任此服务，并了解只读声明的限制</label>
      <button type="button" onClick={onRemove}>移除此服务</button>
    </>}
    {service.server==="context7" && <p className="agent-note">使用匿名公共额度；额度不足时停止，不会借用其他应用的登录或密钥。</p>}
    <button type="button" onClick={()=>void discover()}>{loading?"正在发现工具…":`发现 / 刷新${service.title}工具`}</button>
    {grant && <><p className="agent-note">本对话已选择 {grant.tools.length} 个工具：{grant.tools.join("、")}{!!grant.resourceUris?.length && `；${grant.resourceUris.length} 个资源：${grant.resourceUris.join("、")}`}</p><button type="button" onClick={()=>update()}>撤销本对话的{service.title}工具与资源</button></>}
    {catalog && <>
      {grant && grant.catalogSha256!==catalog.catalogSha256 && <p role="status">服务目录已改变，请重新选择工具并应用；旧授权不能继续调用。</p>}
      {catalog.tools.map(t=><label key={t.name}><input type="checkbox" disabled={!!service.custom&&!trusted} checked={selected.includes(t.name)} onChange={e=>select(t.name,e.target.checked)}/>{t.title||t.name}（{service.custom?"服务声明只读":"只读"}）</label>)}
      {(catalog.resources??[]).map(r=><label key={r.uri}><input type="checkbox" disabled={!!service.custom&&!trusted} checked={selectedResources.includes(r.uri)} onChange={e=>select(r.uri,e.target.checked,true)}/>{r.name} · {r.uri}（只读资源）</label>)}
      {!catalog.resources?.length && <p className="agent-note">当前没有符合接入范围的文本资源。资源须单独勾选；工具结果中的链接不会自动获得读取权限。</p>}
      {catalog.blockedToolCount>0 && <p className="agent-note">另有 {catalog.blockedToolCount} 个工具不在当前开放范围内。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
