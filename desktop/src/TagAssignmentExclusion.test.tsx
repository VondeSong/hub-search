// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagAssignmentExclusion } from "./TagAssignmentExclusion";
const { invoke }=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root; const changed=vi.fn();
const render=(id="p",excluded=false)=>act(async()=>root.render(<TagAssignmentExclusion key={id} proposalId={id} excluded={excluded} disabled={false} onChanged={changed}/>));
const click=(text:string)=>act(async()=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text)!.click());
beforeEach(async()=>{ Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); host=document.createElement("div"); document.body.append(host);root=createRoot(host);changed.mockReset();invoke.mockReset().mockResolvedValue({confirmationToken:"token",change:{title:"Note",tag:"focus",excluded:true}});await render(); });
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("requires preview then explicit confirmation and allows cancellation",async()=>{
  expect(invoke).not.toHaveBeenCalled();await click("预览持续排除");expect(changed).not.toHaveBeenCalled();await click("取消");expect(invoke).toHaveBeenCalledTimes(1);
  await click("预览持续排除");await click("确认持续排除");expect(changed).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"apply_exclusion",proposalId:"p",excluded:true,confirmationToken:"token",requestId:"exclusion-token"}});
});
it("revocation uses the same confirmation boundary and errors discard preview",async()=>{
  await render("revoked",true);invoke.mockResolvedValueOnce({confirmationToken:"token",change:{title:"Note",tag:"focus",excluded:false}});
  await click("预览撤销排除");invoke.mockRejectedValueOnce(Error("预览已失效"));await click("确认撤销排除");
  expect(changed).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')?.textContent).toContain("刷新详情");expect(host.textContent).not.toContain("确认撤销排除");
});
it("ignores a delayed response from a previous proposal",async()=>{
  let resolve!:(v:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await click("预览持续排除");await render("other");
  await act(async()=>resolve({confirmationToken:"late",change:{title:"Old",tag:"old",excluded:true}}));expect(host.textContent).not.toContain("Old");expect(changed).not.toHaveBeenCalled();
});
it("uses only the event target for recovery and still requires confirmation",async()=>{
  await act(async()=>root.render(<TagAssignmentExclusion key="event" exclusionEventId={9} excluded={true} disabled={false} onChanged={changed}/>));
  invoke.mockResolvedValueOnce({confirmationToken:"event-token",change:{title:"事件定位",tag:"focus",entityId:"craft:lib:doc:page",exclusionEventId:9,proposalId:"missing",excluded:false}});
  await click("预览撤销排除");expect(changed).not.toHaveBeenCalled();expect(host.textContent).toContain("craft:lib:doc:page");
  await click("确认撤销排除");expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"apply_exclusion",exclusionEventId:9,excluded:false,confirmationToken:"event-token",requestId:"exclusion-event-token"}});expect(changed).toHaveBeenCalledTimes(1);
});
