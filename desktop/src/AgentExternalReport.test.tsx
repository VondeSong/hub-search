// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentExternalReport} from "./AgentExternalReport";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("does not issue a Work capability when admission is closed",async()=>{
 await act(async()=>root.render(<AgentExternalReport id="w" revision={2} authorization={3} disabled onChanged={()=>{}}/>));
 const button=host.querySelector("button")!;expect(button.disabled).toBe(true);await act(async()=>button.click());expect(invoke).not.toHaveBeenCalled();
});
it("issues once with exact authority, shows supported config and never auto-copies the token",async()=>{
 const changed=vi.fn();invoke.mockResolvedValue({workId:"w",runId:"r",expiresAt:Date.now()+120000,prompt:"只补已保存的报告",mcpServer:{command:"D:\\Hub.exe",args:["--mcp","--data-dir","D:\\isolated"],env:{HUB_EXTERNAL_WORK_TOKEN:"private-token"},enabled:true,required:true,startup_timeout_sec:20,tool_timeout_sec:100}});
 await act(async()=>root.render(<AgentExternalReport id="w" revision={2} authorization={3} disabled={false} onChanged={changed}/>));
 await act(async()=>host.querySelector("button")!.click());
 expect(invoke).toHaveBeenCalledTimes(1);expect(invoke.mock.calls[0][1].args).toEqual({action:"prepareExternalWork",id:"w",purpose:"finishSavedReport",expectedWorkRevision:2,expectedAuthorizationVersion:3});
 expect(changed).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("Hub尚未启动外部模型");
 const config=host.querySelector("textarea")!;expect(config.readOnly).toBe(true);expect(config.value).toContain("[mcp_servers.hub_work.env]");expect(config.value).toContain('command = "D:\\\\Hub.exe"');
 expect(Array.from(host.querySelectorAll("button")).some(b=>b.textContent==="建立一次性连接")).toBe(false);
});
it("shows a failed admission without offering fake connection configuration",async()=>{
 invoke.mockRejectedValue("额度不足");await act(async()=>root.render(<AgentExternalReport id="w" revision={2} authorization={3} disabled={false} onChanged={()=>{}}/>));await act(async()=>host.querySelector("button")!.click());
 expect(host.querySelector('[role="alert"]')!.textContent).toContain("额度不足");expect(host.querySelector("textarea")).toBeNull();
});
