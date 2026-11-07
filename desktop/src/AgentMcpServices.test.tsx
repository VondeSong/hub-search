// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentAssistantOptions,type AssistantOptions} from "./AgentAssistantOptions";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./CodexSuite",()=>({useCodexSuite:()=>({loaded:true,settings:{provider:"codex"}})}));
const catalog={server:"openai_docs",title:"OpenAI 官方文档",endpoint:"https://developers.openai.com/mcp",catalogSha256:"a".repeat(64),tools:[{name:"search_openai_docs",title:"Search OpenAI Docs"},{name:"fetch_openai_doc",title:"Fetch OpenAI Doc"}],blockedToolCount:0};
const contextCatalog={server:"context7",title:"Context7 开发文档",endpoint:"https://mcp.context7.com/mcp",catalogSha256:"c".repeat(64),tools:[{name:"query-docs",title:"Query docs"}],blockedToolCount:0};
let host:HTMLDivElement,root:Root;const save=vi.fn();
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockResolvedValue(catalog);save.mockReset().mockResolvedValue(undefined);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(value:AssistantOptions={model:null,autoFlashcardInbox:false},disabled=false){await act(async()=>root.render(<AgentAssistantOptions section="connection" value={value} disabled={disabled} canAuto={false} onSave={save}/>));}
async function click(text:string){await act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!.click();});}
const remote="https://docs.example.org/mcp";
const remoteCatalog={server:remote,title:"Example",endpoint:remote,custom:true,catalogSha256:"d".repeat(64),tools:[{name:"lookup",title:"Lookup"}],blockedToolCount:2};
const remoteGrant={server:remote,catalogSha256:remoteCatalog.catalogSha256,tools:["lookup"],trustedReadOnly:true};
async function address(value:string){await act(async()=>{const input=host.querySelector<HTMLInputElement>('input[type="url"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
const remoteBoxes=()=>host.querySelectorAll("fieldset")[3].querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
it("custom MCP requires discovery, trust, selection and explicit conversation apply",async()=>{
  await render();await address(remote);await click("添加服务");expect(invoke).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(remoteCatalog);await click("发现 / 刷新docs.example.org");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation",{args:{action:"discoverMcpService",server:remote}});
  expect(remoteBoxes()[1].disabled).toBe(true);await act(async()=>remoteBoxes()[0].click());await act(async()=>remoteBoxes()[1].click());
  expect(save).not.toHaveBeenCalled();await click("应用到本对话");expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,mcpServices:[remoteGrant]});
});
it("custom MCP rejects local, credential URLs and duplicates before discovery",async()=>{
  await render();for(const bad of ["http://example.org/mcp","https://127.0.0.1/mcp","https://docs.internal/mcp","https://key@example.org/mcp","https://example.org/mcp?token=x","https://example.org/mcp#secret"]){await address(bad);await click("添加服务");expect(host.querySelector('[role="alert"]')).not.toBeNull();expect(host.querySelectorAll("fieldset")).toHaveLength(3);}
  await address(catalog.endpoint);await click("添加服务");expect(host.textContent).toContain("已在列表中");
  await address(remote);await click("添加服务");await address(remote);await click("添加服务");expect(host.querySelectorAll("fieldset")).toHaveLength(4);expect(invoke).not.toHaveBeenCalled();
});
it("custom MCP restored grant can lose trust or be removed without changing preset grant",async()=>{
  const preset={server:catalog.server,catalogSha256:catalog.catalogSha256,tools:["search_openai_docs"]};
  const value={model:null,autoFlashcardInbox:false,mcpServices:[preset,remoteGrant]};
  await render(value);expect(remoteBoxes()[0].checked).toBe(true);await act(async()=>remoteBoxes()[0].click());await click("应用到本对话");
  expect(save).toHaveBeenLastCalledWith({model:null,autoFlashcardInbox:false,mcpServices:[preset]});
  await render({...value});await click("移除此服务");await click("应用到本对话");expect(save).toHaveBeenLastCalledWith({model:null,autoFlashcardInbox:false,mcpServices:[preset]});expect(host.querySelectorAll("fieldset")).toHaveLength(3);
});
it("custom MCP stale catalog clears selection and identity mismatch preserves saved grant",async()=>{
  await render({model:null,autoFlashcardInbox:false,mcpServices:[remoteGrant]});
  invoke.mockResolvedValueOnce({...remoteCatalog,catalogSha256:"e".repeat(64)});await click("发现 / 刷新docs.example.org");expect(remoteBoxes()[1].checked).toBe(false);expect(host.textContent).toContain("服务目录已改变");
  invoke.mockResolvedValueOnce(catalog);await click("发现 / 刷新docs.example.org");expect(host.textContent).toContain("服务身份不一致");expect(host.textContent).toContain("本对话已选择 1 个工具");expect(save).not.toHaveBeenCalled();
});
it("cn07c2 resources need separate selection and survive tool toggling",async()=>{
  const uri="https://developers.openai.com/learn/docs-mcp";
  invoke.mockResolvedValue({...catalog,resources:[{uri,name:"Docs resource"}]});
  await render();await click("发现 / 刷新");expect(save).not.toHaveBeenCalled();
  const boxes=()=>host.querySelectorAll<HTMLInputElement>('fieldset:first-of-type input[type="checkbox"]');
  await act(async()=>boxes()[2].click());await act(async()=>boxes()[0].click());await act(async()=>boxes()[0].click());
  await click("应用到本对话");
  expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,mcpServices:[{server:catalog.server,catalogSha256:catalog.catalogSha256,tools:[],resourceUris:[uri]}]});
});
it("cn07c2 changed resource catalog never inherits a saved resource selection",async()=>{
  const uri="https://developers.openai.com/learn/docs-mcp";
  invoke.mockResolvedValue({...catalog,resources:[{uri,name:"Docs resource"}]});
  await render({model:null,autoFlashcardInbox:false,mcpServices:[{server:catalog.server,catalogSha256:"b".repeat(64),tools:[],resourceUris:[uri]}]});
  await click("发现 / 刷新");expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(i=>!i.checked)).toBe(true);
  await click("撤销本对话");await click("应用到本对话");expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false});
});
it("cn07c2 discovers and selects a second service without replacing the first grant",async()=>{
  const openai={server:catalog.server,catalogSha256:catalog.catalogSha256,tools:["search_openai_docs"]};
  await render({model:null,autoFlashcardInbox:false,webSearch:"cached",mcpServices:[openai]});
  invoke.mockResolvedValueOnce(contextCatalog);await click("发现 / 刷新Context7");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation",{args:{action:"discoverMcpService",server:"context7"}});
  await act(async()=>host.querySelectorAll("fieldset")[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(save).not.toHaveBeenCalled();await click("应用到本对话");
  expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,webSearch:"cached",mcpServices:[openai,{server:"context7",catalogSha256:contextCatalog.catalogSha256,tools:["query-docs"]}]});
});
it("cn07c2 revokes only the selected service and its stale catalog cannot inherit another service selection",async()=>{
  const openai={server:catalog.server,catalogSha256:catalog.catalogSha256,tools:["search_openai_docs"]};
  const context={server:"context7",catalogSha256:"b".repeat(64),tools:["query-docs"]};
  await render({model:null,autoFlashcardInbox:false,mcpServices:[openai,context]});
  invoke.mockResolvedValueOnce(contextCatalog);await click("发现 / 刷新Context7");
  expect(host.querySelectorAll("fieldset")[1].textContent).toContain("服务目录已改变");
  expect(host.querySelectorAll("fieldset")[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  await click("撤销本对话的Context7");await click("应用到本对话");
  expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,mcpServices:[openai]});
});
it("cn07c discovers without granting and applies exactly selected tools",async()=>{
  await render();expect(invoke).not.toHaveBeenCalled();await click("发现 / 刷新");expect(save).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation",{args:{action:"discoverMcpService",server:"openai_docs"}});
  await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(save).not.toHaveBeenCalled();
  await click("应用到本对话");expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,mcpServices:[{server:catalog.server,catalogSha256:catalog.catalogSha256,tools:["search_openai_docs"]}]});
});
it("cn07c stages revocation and preserves other conversation options",async()=>{
  await render({model:null,autoFlashcardInbox:false,webSearch:"cached",mcpServices:[{server:catalog.server,catalogSha256:catalog.catalogSha256,tools:["fetch_openai_doc"]}]});
  await click("撤销本对话");expect(save).not.toHaveBeenCalled();await click("应用到本对话");expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:false,webSearch:"cached"});
});
it("cn07c changed catalog never silently inherits old selections; discovery failure keeps saved grant",async()=>{
  const value:AssistantOptions={model:null,autoFlashcardInbox:false,mcpServices:[{server:catalog.server,catalogSha256:"b".repeat(64),tools:["search_openai_docs"]}]};
  await render(value);await click("发现 / 刷新");expect(host.textContent).toContain("服务目录已改变");expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(i=>!i.checked)).toBe(true);expect(save).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce(new Error("服务不可用"));await click("发现 / 刷新");expect(host.textContent).toContain("服务不可用");expect(host.textContent).toContain("本对话已选择 1 个工具");expect(save).not.toHaveBeenCalled();
});
