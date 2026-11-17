import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

export type McpGrant={server:string;catalogSha256:string;tools:string[];resourceUris?:string[];trustedReadOnly?:boolean;appBinding?:{accountScope:string;connectionSha256:string;writeRepository?:string}};
type Catalog={server:string;title:string;endpoint:string;catalogSha256:string;tools:{name:string;title?:string;description?:string;annotations?:{readOnlyHint?:boolean}}[];resources?:{uri:string;name:string}[];blockedToolCount:number;custom?:boolean;appBinding?:McpGrant["appBinding"]};
type Service={server:string;title:string;endpoint:string;custom?:boolean;connected?:boolean;browser?:boolean};
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
    <NativeConnections {...props}/>
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
  const [repository,setRepository]=useState(grant?.appBinding?.writeRepository??"");
  const selected=grant?.catalogSha256===catalog?.catalogSha256?grant?.tools??[]:[];
  const selectedResources=grant?.catalogSha256===catalog?.catalogSha256?grant?.resourceUris??[]:[];
  async function discover() {
    setLoading(true);setError("");setCatalog(null);
    try {const result=await invoke<Catalog>("agent_investigation",{args:{action:"discoverMcpService",server:service.server}});if(result.server!==service.server)throw new Error("返回的服务身份不一致，请重新发现。");if(alive.current)setCatalog(result);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally {if(alive.current)setLoading(false);}
  }
  function update(grant?:McpGrant) {
    onChange([...value.filter(g=>g.server!==service.server&&!(grant&&service.browser&&g.server.startsWith("browser:"))),...(grant?[grant]:[])]);
  }
  function select(name:string,enabled:boolean,resource=false) {
    if(!catalog || disabled || loading || (service.custom && !trusted))return;
    const old=resource?selectedResources:selected;
    const next=enabled?[...old,name]:old.filter(t=>t!==name);
    const tools=resource?selected:next;
    const resourceUris=resource?next:selectedResources;
    const writes=tools.includes("github.add_comment_to_issue");
    if(writes&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim())){setError("选择评论工具前，请填写明确的 owner/repository 目标仓库。");return;}
    update(tools.length||resourceUris.length?{server:catalog.server,catalogSha256:catalog.catalogSha256,tools,...(resourceUris.length?{resourceUris}:{}),...(service.custom?{trustedReadOnly:true}:{}),...(catalog.appBinding?{appBinding:{...catalog.appBinding,...(writes?{writeRepository:repository.trim()}:{})}}:{})}:undefined);
    setError("");
  }
  return <fieldset className="agent-mcp-service" disabled={disabled||loading}>
    <legend>{service.browser?"浏览器操作":service.connected?"已连接应用":"外部 MCP 服务"} · {service.title}</legend>
    <p className="agent-note">{service.endpoint}</p>
    <p className="agent-note">{service.browser?"独立临时浏览器，仅访问所列网站。不继承登录态。导航后使用页面快照取得元素引用，再点击、填写或切换标签；写请求、文件和脚本操作不开放。会话在本轮结束后关闭，历史记录不代表浏览器仍存活。":service.connected?"使用当前 Codex 登录账号已有的应用连接，逐工具授权；不会导入第三方密钥。参数会发送给此应用，只发送本次任务需要且获准的内容。连接或账号改变后需重新选择。可查询该账号中此工具能访问的数据，请仅选择本次任务需要的工具。只读标注来自服务声明。":"无需登录，用于公开资料查询。调用参数会发送给此服务；这不授予发送私密正文或凭据的权限。"}只作用于本对话，勾选后还需应用。返回内容作为外部资料，不能替代原文核验或保存授权。</p>
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
      {catalog.tools.some(t=>t.name==="github.add_comment_to_issue")&&<><label>允许评论的 GitHub 仓库<input type="text" value={repository} placeholder="owner/repository" onChange={e=>{setRepository(e.target.value);if(grant?.tools.includes("github.add_comment_to_issue")){const tools=grant.tools.filter(t=>t!=="github.add_comment_to_issue");update(tools.length?{...grant,tools,appBinding:catalog.appBinding}:undefined);}}}/></label><p className="agent-note">评论工具只准备草稿，确认后才发布到此仓库。包括核对该 Issue 及回读评论的权限。其他写入、编辑或删除工具不开放。</p></>}
      {catalog.tools.map(t=><label key={t.name} title={t.description}><input type="checkbox" disabled={!!service.custom&&!trusted} checked={selected.includes(t.name)} onChange={e=>select(t.name,e.target.checked)}/>{t.title||t.name}（{t.name==="github.add_comment_to_issue"?"准备评论 · 需确认":service.browser?"浏览器交互":service.custom||service.connected?"服务声明只读":"只读"}）</label>)}
      {(catalog.resources??[]).map(r=><label key={r.uri}><input type="checkbox" disabled={!!service.custom&&!trusted} checked={selectedResources.includes(r.uri)} onChange={e=>select(r.uri,e.target.checked,true)}/>{r.name} · {r.uri}（只读资源）</label>)}
      {!catalog.resources?.length && <p className="agent-note">当前没有符合接入范围的文本资源。资源须单独勾选；工具结果中的链接不会自动获得读取权限。</p>}
      {catalog.blockedToolCount>0 && <p className="agent-note">另有 {catalog.blockedToolCount} 个工具不在当前开放范围内。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

function NativeConnections(props:Props) {
  const [apps,setApps]=useState<Service[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [sites,setSites]=useState("");
  const [browser,setBrowser]=useState<Service|null>(null);
  const [ready,setReady]=useState(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function list() {
    setBusy(true);setError("");
    try {const result=await invoke<{apps:{server:string;title:string}[]}>("agent_investigation",{args:{action:"listConnectedApps"}});if(alive.current)setApps(result.apps.map(app=>({...app,endpoint:"当前 Codex 账号的应用连接",connected:true})));}
    catch(reason){if(alive.current)setError(String(reason));}
    finally{if(alive.current)setBusy(false);}
  }
  async function prepare() {
    setBusy(true);setError("");
    try {await invoke("agent_investigation",{args:{action:"prepareBrowserRuntime"}});if(alive.current)setReady(true);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally{if(alive.current)setBusy(false);}
  }
  function addBrowser() {
    try {
      const origins=sites.split(/[\s,，]+/).filter(Boolean).map(raw=>{const url=new URL(raw);if(url.protocol!=="https:"||url.username||url.password||url.port||url.pathname!=="/"||url.search||url.hash||!url.hostname.includes(".")||url.hostname.endsWith(".")||/(?:^|\.)(localhost|local|internal)$/.test(url.hostname)||/^\d+(?:\.\d+){3}$/.test(url.hostname)||url.hostname.includes(":"))throw Error("请填写公开网站的 HTTPS 地址，不含路径、登录信息或端口。");return url.origin;});
      if(!origins.length||origins.length>8||new Set(origins).size!==origins.length)throw Error("请填写 1 至 8 个不重复的网站地址，以空格分开。");
      setBrowser({server:`browser:${origins.join("|")}`,title:"独立浏览器",endpoint:origins.join("、"),browser:true});setError("");
    }catch(reason){setError(String(reason));}
  }
  const restored=props.value.filter(g=>g.server.startsWith("app:")).map(g=>({server:g.server,title:g.server==="app:connector_76869538009648d5b282a4bb21c3d157"?"GitHub":"已选应用",endpoint:"已保存的应用授权；刷新后核对账号与连接",connected:true}));
  const merged=[...apps,...restored.filter(r=>!apps.some(a=>a.server===r.server))];
  const browsers=[...(browser?[browser]:[]),...props.value.filter(g=>g.server.startsWith("browser:")&&g.server!==browser?.server).map(g=>({server:g.server,title:"独立浏览器",endpoint:g.server.slice(8).split("|").join("、"),browser:true}))];
  return <section aria-label="应用与浏览器连接">
    <p className="agent-note">应用连接与浏览器操作</p>
    <button type="button" disabled={props.disabled||busy} onClick={()=>void list()}>{busy?"正在连接…":"查看当前 Codex 账号的应用"}</button>
    {merged.map(service=><ServiceTools key={service.server} service={service} {...props}/>)}
    <p className="agent-note">浏览器使用 Microsoft Playwright MCP 与本机 Edge / Chrome，需要 Node.js 22 或更新版本。首次准备会下载锁定版本的组件。</p>
    <button type="button" disabled={props.disabled||busy} onClick={()=>void prepare()}>{ready?"浏览器组件已准备，可重新检查":"准备浏览器组件"}</button>
    <label>允许浏览的网站<input type="text" value={sites} disabled={props.disabled||busy} placeholder="https://developers.openai.com" onChange={e=>setSites(e.target.value)}/></label>
    <button type="button" disabled={props.disabled||busy||!sites.trim()} onClick={addBrowser}>设置网站范围</button>
    {browsers.map(service=><ServiceTools key={service.server} service={service} {...props}/>)}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
