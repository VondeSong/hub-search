// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentMcpServices,type McpGrant} from "./AgentMcpServices";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root,value:McpGrant[];
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);value=[];invoke.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(disabled=false){await act(async()=>root.render(<AgentMcpServices value={value} disabled={disabled} onChange={v=>{value=v;void render();}}/>));}
async function click(text:string){await act(async()=>{[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes(text))!.click();});}
async function input(text:string){await act(async()=>{const element=host.querySelector<HTMLInputElement>('input[type="text"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,text);element.dispatchEvent(new Event("input",{bubbles:true}));});}
it("does not inherit app connections and keeps the exact discovered account binding on selection",async()=>{
  const server="app:connector_github",binding={accountScope:"account",connectionSha256:"a".repeat(64)};
  await render();expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({apps:[{server,title:"GitHub"}]});await click("查看当前 Codex 账号");
  invoke.mockResolvedValueOnce({server,title:"GitHub",endpoint:"Codex",catalogSha256:"b".repeat(64),appBinding:binding,tools:[{name:"github.fetch_issue"}],blockedToolCount:0});await click("发现 / 刷新GitHub");
  await act(async()=>[...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(e=>e.parentElement?.textContent?.includes("github.fetch_issue"))!.click());
  expect(value).toEqual([{server,catalogSha256:"b".repeat(64),tools:["github.fetch_issue"],appBinding:binding}]);
  await click("撤销本对话的GitHub");expect(value).toEqual([]);
});
it("validates browser scope before discovery and does not authorize tools on preparation",async()=>{
  await render();invoke.mockResolvedValueOnce({ready:true});await click("准备浏览器组件");expect(value).toEqual([]);
  for(const bad of ["https://localhost","https://127.0.0.1","https://docs.internal","https://user@example.com","https://example.com/private","http://example.com"]){await input(bad);await click("设置网站范围");expect(host.querySelector('[role="alert"]')).not.toBeNull();}
  expect(invoke).toHaveBeenCalledTimes(1);
  await input("https://developers.openai.com https://github.com");await click("设置网站范围");expect(value).toEqual([]);
  const server="browser:https://developers.openai.com|https://github.com";
  invoke.mockResolvedValueOnce({server,title:"Browser",endpoint:"Playwright",catalogSha256:"c".repeat(64),tools:[{name:"browser_navigate"}],blockedToolCount:0});await click("发现 / 刷新独立浏览器");
  await act(async()=>[...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(e=>e.parentElement?.textContent?.includes("browser_navigate"))!.click());
  expect(value).toEqual([{server,catalogSha256:"c".repeat(64),tools:["browser_navigate"]}]);
});
it("disables app discovery, runtime setup and website changes while the conversation is running",async()=>{
  await render(true);await click("查看当前 Codex 账号");await click("准备浏览器组件");expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
});
it("requires a concrete repository for the supported write tool and removes its grant when that target changes",async()=>{
  const server="app:connector_76869538009648d5b282a4bb21c3d157",binding={accountScope:"account",connectionSha256:"a".repeat(64)};
  await render();invoke.mockResolvedValueOnce({apps:[{server,title:"GitHub"}]});await click("查看当前 Codex 账号");
  invoke.mockResolvedValueOnce({server,title:"GitHub",endpoint:"Codex",catalogSha256:"b".repeat(64),appBinding:binding,tools:[{name:"github.add_comment_to_issue",annotations:{readOnlyHint:false}}],blockedToolCount:10});await click("发现 / 刷新GitHub");
  const select=()=>[...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(e=>e.parentElement?.textContent?.includes("github.add_comment_to_issue"))!;
  await act(async()=>select().click());expect(value).toEqual([]);expect(host.textContent).toContain("目标仓库");
  await input("VondeSong/hub-search");await act(async()=>select().click());
  expect(value[0].appBinding?.writeRepository).toBe("VondeSong/hub-search");expect(host.textContent).toContain("需确认");
  await input("VondeSong/another");expect(value).toEqual([]);
});
