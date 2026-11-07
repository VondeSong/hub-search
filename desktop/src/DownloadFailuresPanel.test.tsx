// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DownloadFailuresPanel } from "./DownloadFailuresPanel";
import type { DownloadFailureItem, DownloadFailurePage } from "./DownloadFailureTypes";

const mocks=vi.hoisted(() => ({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",() => ({invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",() => ({listen:vi.fn()}));

let host:HTMLDivElement,root:Root;
const changed=vi.fn();
const item=(jobId=1,overrides:Partial<DownloadFailureItem>={}):DownloadFailureItem => ({
  jobId,sourceId:`source-${jobId}`,sourceType:"craft_attachment",jobType:"download_source",title:`file-${jobId}.png`,
  libraryId:"library",libraryName:"Archive",provider:"craft",documentId:"doc",parentTitle:"Source document",documentPath:"Notes/Source document",
  mimeType:"image/png",sourceReference:"https://r.craft.do/file?X-Amz-Signature=secret",error:"HTTP 503 https://r.craft.do/file?X-Amz-Signature=secret",
  attempts:3,updatedAt:123,resourceGeneration:2,status:"failed",hasCache:false,canRetry:true,canSkip:true,issueState:"failed",...overrides,
});
const page=(items:DownloadFailureItem[],overrides:Partial<DownloadFailurePage>={}):DownloadFailurePage => ({
  items,total:items.length,failedCount:items.filter(row=>row.issueState!=="dismissed").length,
  skippedCount:items.filter(row=>row.issueState==="dismissed").length,
  libraries:[{id:"library",name:"Archive",provider:"craft",failedCount:1,skippedCount:0}],changed:0,unchanged:0,offset:0,...overrides,
});
const render=async (spaceId:string|null=null) => act(async () => root.render(<DownloadFailuresPanel spaceId={spaceId} onChanged={changed}/>));
const click=async (label:string) => {
  const button=[...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate=>candidate.textContent===label||candidate.getAttribute("aria-label")===label);
  expect(button,`button ${label}`).toBeDefined();await act(async()=>button!.click());
};
beforeEach(() => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  mocks.invoke.mockReset();changed.mockReset();host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async () => {
  await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.restoreAllMocks();
  delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;
});

it("loads only inspection records and hides signed addresses without starting retry",async () => {
  let resolve!:(value:DownloadFailurePage)=>void;
  mocks.invoke.mockImplementation(()=>new Promise<DownloadFailurePage>(done=>{resolve=done;}));
  await render();expect(host.textContent).toContain("正在读取下载记录");
  await act(async()=>resolve(page([item()])));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("attachment_download_failures",{args:{action:"list",libraryId:null,status:"failed",offset:0,limit:25}});
  expect(host.textContent).toContain("Source document");expect(host.textContent).toContain("已尝试 3 次");
  expect(host.innerHTML).not.toContain("secret");expect(host.innerHTML).not.toContain("https://r.craft.do");
});

it("skips one exact attachment then explicitly retries it from the skipped view",async () => {
  const failed=item();const skipped=item(1,{status:"dismissed",issueState:"dismissed",canSkip:false,updatedAt:124});
  mocks.invoke.mockImplementation(async (_command,{args}) => {
    if(args.action==="skip") return page([],{failedCount:0,skippedCount:1,changed:1});
    if(args.action==="retry") return page([],{failedCount:1,skippedCount:0,changed:1});
    return args.status==="dismissed" ? page([skipped],{failedCount:0,skippedCount:1}) : page([failed]);
  });
  await render();await click("跳过 file-1.png");
  expect(mocks.invoke).toHaveBeenLastCalledWith("attachment_download_failures",{args:{action:"skip",libraryId:null,status:"failed",offset:0,limit:25,
    items:[{jobId:1,sourceId:"source-1",resourceGeneration:2,updatedAt:123,status:"failed"}]}});
  expect(host.textContent).toContain("已跳过 1 个附件");
  await click("已跳过 1");await click("再次重试 file-1.png");
  expect(mocks.invoke).toHaveBeenLastCalledWith("attachment_download_failures",{args:{action:"retry",libraryId:null,status:"dismissed",offset:0,limit:25,
    items:[{jobId:1,sourceId:"source-1",resourceGeneration:2,updatedAt:124,status:"dismissed"}]}});
  expect(host.textContent).toContain("已重新排队 1 个附件");expect(host.textContent).not.toContain("下载成功");expect(changed).toHaveBeenCalledTimes(2);
});

it("limits bulk retry to eligible identities on the current page",async () => {
  const records=Array.from({length:26},(_,index)=>item(index+1));
  records[1]=item(2,{status:"running",issueState:"retrying",canRetry:false,canSkip:false});
  mocks.invoke.mockImplementation(async (_command,{args}) => page(records.slice(args.offset,args.offset+args.limit),{
    total:26,failedCount:26,offset:args.offset,changed:args.action==="retry" ? args.items.length : 0,
  }));
  await render();await click("重试本页");
  const first=mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1][1].args;
  expect(first.items.map((target:{jobId:number})=>target.jobId)).toEqual([1,...Array.from({length:23},(_,index)=>index+3)]);
  await click("下一页");await click("重试本页");
  expect(mocks.invoke).toHaveBeenLastCalledWith("attachment_download_failures",{args:{action:"retry",libraryId:null,status:"failed",offset:25,limit:25,
    items:[{jobId:26,sourceId:"source-26",resourceGeneration:2,updatedAt:123,status:"failed"}]}});
});

it("discards a late list response when the selected library changes",async () => {
  let finish!:(value:DownloadFailurePage)=>void;
  mocks.invoke.mockImplementation(async (_command,{args}) => args.libraryId==="first"
    ? new Promise<DownloadFailurePage>(resolve=>{finish=resolve;}) : page([item(2,{libraryId:"second",title:"Current file"})]));
  await render("first");await render("second");
  await act(async()=>{finish(page([item(1,{title:"Old file"})]));await Promise.resolve();});
  expect(host.textContent).toContain("Current file");expect(host.textContent).not.toContain("Old file");
  expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1][1].args.libraryId).toBe("second");
});

it("returns to the last valid page when polling observes that its current records disappeared",async () => {
  vi.useFakeTimers();vi.spyOn(document,"hidden","get").mockReturnValue(false);
  let records=Array.from({length:26},(_,index)=>item(index+1));
  let lastReturned:DownloadFailurePage|undefined;
  mocks.invoke.mockImplementation(async (_command,{args}) => {
    const actualOffset=records.length<=25 ? 0 : args.offset;
    lastReturned=page(records.slice(actualOffset,actualOffset+args.limit),{total:records.length,failedCount:records.length,offset:actualOffset});
    return lastReturned;
  });
  await render();await click("下一页");
  const removedIds=new Set(lastReturned!.items.map(record=>record.jobId));
  expect(removedIds.size).toBe(1);
  records=records.filter(record=>!removedIds.has(record.jobId));
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(lastReturned!.offset).toBe(0);
  expect(host.querySelectorAll(".download-failure-item")).toHaveLength(records.length);
  expect(host.textContent).not.toContain("当前没有需要处理的下载失败");
  expect(host.textContent).toContain(`1–${records.length} / ${records.length}`);
  await click("刷新下载记录");
  expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1][1].args.offset).toBe(lastReturned!.offset);
});

it("does not apply or refresh an old mutation after returning and opening another page",async () => {
  let finish!:(value:DownloadFailurePage)=>void;
  mocks.invoke.mockImplementation(async (_command,{args}) => args.action==="skip"
    ? new Promise<DownloadFailurePage>(resolve=>{finish=resolve;}) : page([item(args.libraryId==="current"?2:1,{title:args.libraryId==="current"?"Current file":"Old file"})]));
  await render("old");await click("跳过 Old file");
  await act(async()=>root.render(null));await render("current");
  await act(async()=>finish(page([item(1,{title:"Late old file"})],{changed:1})));
  expect(host.textContent).toContain("Current file");expect(host.textContent).not.toContain("Late old file");expect(changed).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.filter(([,payload])=>payload.args.action==="skip")).toHaveLength(1);
});

it("allows a failed inspection read to recover without retrying any download",async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("query failed https://r.craft.do/file?token=secret")).mockResolvedValue(page([]));
  await render();expect(host.querySelector('[role="alert"]')).not.toBeNull();expect(host.innerHTML).not.toContain("secret");
  await click("重新读取");expect(host.textContent).toContain("当前没有需要处理的下载失败");
  expect(mocks.invoke.mock.calls.every(([,payload])=>payload.args.action==="list")).toBe(true);
});
