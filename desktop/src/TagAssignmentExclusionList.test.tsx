// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagAssignmentExclusionList } from "./TagAssignmentExclusionList";
vi.mock("./TagAssignmentExclusionReminder",()=>({TagAssignmentExclusionReminder:({onOpen}:{onOpen:()=>void})=><button type="button" onClick={onOpen}>打开待复核清单</button>}));
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;const changed=vi.fn();
const entry={id:2,tag:"focus",entityId:"entity",proposalId:"p",excluded:true,createdAt:1,proposalTitle:"Note",canManage:true};
const render=(tagId="focus")=>act(async()=>root.render(<TagAssignmentExclusionList key={tagId} tagId={tagId} onChanged={changed}/>));
const click=(text:string)=>act(async()=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text)!.click());
beforeEach(async()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);changed.mockReset();invoke.mockReset().mockResolvedValue({items:[entry],nextCursor:"next",snapshotVersion:2,mode:"active"});await render();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("loads on demand, preserves failed pages and distinguishes audit from current state",async()=>{
  expect(invoke).not.toHaveBeenCalled();await click("查看当前排除");expect(host.textContent).toContain("Note");
  invoke.mockRejectedValueOnce(Error("offline"));await click("加载更多排除记录");expect(host.textContent).toContain("Note");expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  await click("加载更多排除记录");expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"list_exclusions",tag:"focus",mode:"active",limit:20,cursor:"next"}});
  invoke.mockResolvedValueOnce({items:[entry],nextCursor:null,snapshotVersion:2,mode:"history"});await click("查看操作历史");expect(host.textContent).toContain("非当前状态");expect(host.textContent).not.toContain("预览撤销排除");expect(changed).not.toHaveBeenCalled();
});
it("opens the review list from its reminder without changing preferences",async()=>{
  invoke.mockResolvedValueOnce({items:[],nextCursor:null,snapshotVersion:2,mode:"review"});await click("打开待复核清单");
  expect(host.querySelector("details")?.open).toBe(true);expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"list_exclusions",tag:"focus",mode:"review",limit:20,olderThanDays:90}});expect(changed).not.toHaveBeenCalled();
});
it("revokes only after separate preview and confirmation then refreshes",async()=>{
  await click("查看当前排除");invoke.mockResolvedValueOnce({confirmationToken:"token",change:{title:"Note",tag:"focus",excluded:false}});await click("预览撤销排除");expect(changed).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({}).mockResolvedValueOnce({items:[],nextCursor:null,snapshotVersion:3,mode:"active"});await click("确认撤销排除");expect(changed).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("暂无已启用排除");
});
it("ignores late responses after scope changes and marks missing origins",async()=>{
  let resolve!:(v:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await click("查看当前排除");await render("other");await act(async()=>resolve({items:[entry],nextCursor:null,mode:"active",snapshotVersion:2}));expect(host.textContent).not.toContain("Note");
  invoke.mockResolvedValueOnce({items:[{...entry,canManage:false,proposalTitle:""}],nextCursor:null,mode:"active",snapshotVersion:2});await click("查看当前排除");expect(host.textContent).toContain("不重建来源建议");expect(host.textContent).toContain("预览撤销排除");
  invoke.mockResolvedValueOnce({confirmationToken:"event",change:{title:"按事件定位",tag:"focus",entityId:"entity",exclusionEventId:2,proposalId:"p",excluded:false}});await click("预览撤销排除");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"preview_exclusion",exclusionEventId:2,excluded:false}});expect(host.textContent).toContain("请核对精确作用域");expect(changed).not.toHaveBeenCalled();
});
it("uses explicit age thresholds and keeps revocation behind confirmation",async()=>{
  invoke.mockResolvedValueOnce({items:[entry],nextCursor:"review-cursor",snapshotVersion:2,mode:"review"});
  await click("查看待复核排除");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"list_exclusions",tag:"focus",mode:"review",limit:20,olderThanDays:90}});
  expect(host.textContent).toContain("到期不会自动撤销");expect(host.textContent).toContain("预览撤销排除");expect(changed).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({items:[],nextCursor:null,snapshotVersion:2,mode:"review"});await click("加载更多排除记录");
  expect(invoke.mock.calls[invoke.mock.calls.length-1][1].args).toMatchObject({olderThanDays:90,cursor:"review-cursor"});
  const select=host.querySelector("select")!;await act(async()=>{select.value="30";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(host.textContent).not.toContain("Note");
  invoke.mockResolvedValueOnce({items:[],nextCursor:null,snapshotVersion:2,mode:"review"});await click("查看待复核排除");
  expect(invoke.mock.calls[invoke.mock.calls.length-1][1].args).toMatchObject({olderThanDays:30});
  expect(invoke.mock.calls[invoke.mock.calls.length-1][1].args.cursor).toBeUndefined();
});
it("records keep-excluded only after preview and exact-date confirmation",async()=>{
  await click("查看当前排除");
  invoke.mockResolvedValueOnce({confirmationToken:"review-token",change:{tag:"focus",entityId:"entity",nextReviewAt:2000000000}});
  await click("预览继续排除");expect(changed).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"preview_exclusion_review",exclusionEventId:2,reviewAfterDays:90}});
  invoke.mockResolvedValueOnce({}).mockResolvedValueOnce({items:[],nextCursor:null,snapshotVersion:2,mode:"active"});
  await click("确认继续排除");expect(changed).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls.some(c=>c[1].args.action==="apply_exclusion_review"&&c[1].args.nextReviewAt===2000000000&&c[1].args.confirmationToken==="review-token")).toBe(true);
});
it("cancels review without writing and drops stale confirmations",async()=>{
  await click("查看当前排除");
  const preview={confirmationToken:"review-token",change:{tag:"focus",entityId:"entity",nextReviewAt:2000000000}};
  invoke.mockResolvedValueOnce(preview);await click("预览继续排除");await click("取消");
  expect(invoke.mock.calls.some(c=>c[1].args.action==="apply_exclusion_review")).toBe(false);
  invoke.mockResolvedValueOnce(preview);await click("预览继续排除");invoke.mockRejectedValueOnce(Error("预览已失效"));await click("确认继续排除");
  expect(host.textContent).toContain("预览已失效");expect(host.textContent).not.toContain("确认继续排除");expect(changed).not.toHaveBeenCalled();
});
