// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagAssignmentExclusionHistory } from "./TagAssignmentExclusionHistory";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const page={tag:"focus",entityId:"one",items:[{id:2,reviewedAt:1,nextReviewAt:2}],nextCursor:"next"};
const render=(id=1)=>act(async()=>root.render(<TagAssignmentExclusionHistory key={id} exclusionEventId={id}/>));
const click=(text:string)=>act(async()=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text)!.click());
beforeEach(async()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockResolvedValue(page);await render();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("loads on demand, preserves pages on error and appends without duplicates",async()=>{
  expect(invoke).not.toHaveBeenCalled();await click("读取复核历史");expect(host.textContent).toContain("不代表当前排除状态");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"exclusion_review_history",exclusionEventId:1,limit:20}});
  invoke.mockRejectedValueOnce(Error("offline"));await click("加载更多复核历史");expect(host.textContent).toContain("记录 2");expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  invoke.mockResolvedValueOnce({...page,items:[...page.items,{id:1,reviewedAt:1,nextReviewAt:3}],nextCursor:null});await click("加载更多复核历史");
  expect(host.querySelectorAll("li")).toHaveLength(2);expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"exclusion_review_history",exclusionEventId:1,limit:20,cursor:"next"}});
  invoke.mockResolvedValueOnce({...page,items:[],nextCursor:null});await click("读取复核历史");expect(host.textContent).toContain("暂无复核记录");
  expect(invoke.mock.calls.every(c=>c[1].args.action==="exclusion_review_history")).toBe(true);
});
it("ignores stale responses after event changes",async()=>{
  let resolve!:(v:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await click("读取复核历史");await render(2);await act(async()=>resolve(page));expect(host.textContent).not.toContain("记录 2");
  await click("读取复核历史");expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"exclusion_review_history",exclusionEventId:2,limit:20}});
});
