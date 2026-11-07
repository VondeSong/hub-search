// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FooterStatus } from "./FooterStatus";
import type { FailedIndexItem, IndexStatus } from "./IndexStatusTypes";

const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn()}));
vi.mock("./CodexSuiteFooter",()=>({CodexSuiteFooter:()=>null}));

const failed=(jobId:number,jobType:string,title:string):FailedIndexItem => ({jobId,sourceId:`source-${jobId}`,sourceType:"craft_attachment",jobType,title,error:`${title} error`,attempts:3,updatedAt:123});
const status:IndexStatus = {
  journalVersions:[],documentCount:1,pendingJobs:0,pendingDownloads:0,pendingOcrPages:0,pendingOtherJobs:0,deferredOcrSources:0,
  failedJobs:2,failedOcrPages:1,pendingLexicalJobs:0,rateLimitEvents:0,autoSyncEnabled:false,autoSyncConsecutiveFailures:0,
  jobDetails:[{jobType:"download_source",status:"failed",count:1,lastError:"Download filename error"},{jobType:"ocr_page",status:"failed",count:1,lastError:"OCR filename error"}],
  libraryHealth:[{libraryId:"library",provider:"craft",name:"Archive",documentCount:1,pendingJobs:0,failedJobs:2,consecutiveFailures:0,
    failedItems:[failed(1,"download_source","Download filename"),failed(2,"ocr_page","OCR filename")]}],obsidianWatchers:[],
};
const retry=vi.fn(),dismiss=vi.fn(),refresh=vi.fn();
let host:HTMLDivElement,root:Root;
function Harness() {
  const [opened,setOpened]=useState(true);
  return <FooterStatus dismissFailedJobs={dismiss} dismissingFailedJobs={false} indexDetailsOpen={opened}
    indexJobTypeLabel={job=>job} indexStatus={status} operationStatus={null} refreshIndex={vi.fn()}
    retryFailedJobs={retry} retryingFailedJobs={false} spaces={[]} setIndexDetailsOpen={setOpened}
    setShowConnection={vi.fn()} startWindowDrag={vi.fn()} syncing={false} versionLabel="test"
    statusSpaceId="library" refreshStatus={refresh}/>;
}
const click=async (label:string)=>{
  const button=[...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate=>candidate.textContent===label||candidate.getAttribute("aria-label")===label);
  expect(button,`button ${label}`).toBeDefined();await act(async()=>button!.click());
};
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  retry.mockReset();dismiss.mockReset();refresh.mockReset();mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({items:[],total:0,failedCount:0,skippedCount:0,libraries:[],changed:0,unchanged:0,offset:0});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();delete (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;});

it("moves download inspection to a secondary health page and returns to its entry",async()=>{
  await act(async()=>root.render(<Harness/>));
  expect(host.textContent).not.toContain("Download filename error");expect(host.textContent).toContain("OCR filename error");
  expect(host.querySelector(".download-failures-entry")?.textContent).toBe("附件下载失败查看失败和已跳过的附件");
  expect(mocks.invoke).not.toHaveBeenCalled();
  const entry=host.querySelector<HTMLButtonElement>(".download-failures-entry")!;
  await act(async()=>entry.click());
  expect(host.querySelector('[aria-label="附件下载失败"]')).not.toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("attachment_download_failures",{args:{action:"list",libraryId:"library",status:"failed",offset:0,limit:25}});
  await click("返回同步健康中心");
  expect(host.querySelector(".download-failures-panel")).toBeNull();expect(document.activeElement).toBe(host.querySelector(".download-failures-entry"));
});

it("routes overview bulk maintenance through the non-download scope",async()=>{
  await act(async()=>root.render(<Harness/>));
  await click("重试其他失败任务");await click("跳过并存档");
  expect(retry).toHaveBeenCalledWith({excludeDownloads:true});expect(dismiss).toHaveBeenCalledWith({excludeDownloads:true});
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("opens the durable archive including non-download work",async()=>{
  await act(async()=>root.render(<Harness/>));
  await click("已跳过记录下载、文字识别与索引任务的存档");
  expect(mocks.invoke).toHaveBeenCalledWith("skipped_index_jobs",{args:{action:"list",libraryId:"library",offset:0}});
  expect(host.querySelector('[aria-label="已跳过记录"]')).not.toBeNull();
  await click("返回同步健康中心");
  expect(host.querySelector('[aria-label="同步健康中心"]')).not.toBeNull();
});

it("shows unsupported OCR as not applicable without offering a failure retry",async()=>{
  const prior={...status};
  Object.assign(status,{failedJobs:0,failedOcrPages:0,libraryHealth:[],jobDetails:[{jobType:"ocr_page",status:"not_applicable",count:4,lastError:"视频不适用文字识别，原件保留"}]});
  try {
    await act(async()=>root.render(<Harness/>));
    const row=host.querySelector('.index-detail-row.not_applicable');
    expect(row?.textContent).toContain("不适用文字识别 · 4");
    expect(row?.textContent).not.toContain("等待处理");
    expect(host.textContent).not.toContain("重试其他失败任务");
  } finally {Object.assign(status,prior);}
});
