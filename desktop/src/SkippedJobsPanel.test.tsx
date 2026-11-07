// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SkippedJobsPanel } from "./SkippedJobsPanel";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
let root:Root,host:HTMLDivElement;
const item={id:1,title:"cad.png",parentTitle:"Parent",libraryName:"Archive",jobType:"ocr_page",error:"failed",attempts:3,archivedAt:100,status:"dismissed",updatedAt:101,canRetry:true};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);mocks.invoke.mockReset();mocks.invoke.mockResolvedValue({items:[item],total:1,offset:0,changed:false});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("keeps OCR history visible after manual retry and includes the snapshot version",async()=>{
  await act(async()=>root.render(<SkippedJobsPanel/>));expect(host.textContent).toContain("文字识别 · 已跳过");
  mocks.invoke.mockResolvedValue({items:[{...item,status:"pending",canRetry:false}],total:1,offset:0,changed:true});
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="重试已跳过的任务 cad.png"]')!.click());
  expect(mocks.invoke).toHaveBeenLastCalledWith("skipped_index_jobs",{args:{action:"retry",libraryId:null,offset:0,archiveId:1,updatedAt:101}});
  expect(host.textContent).toContain("跳过记录继续保留");expect(host.textContent).toContain("cad.png");expect(host.textContent).toContain("已重新安排");
});
it("shows records whose original source no longer exists without offering an invalid retry",async()=>{
  mocks.invoke.mockResolvedValue({items:[{...item,status:null,canRetry:false}],total:1,offset:0,changed:false});
  await act(async()=>root.render(<SkippedJobsPanel/>));expect(host.textContent).toContain("原记录存档");expect(host.querySelector('[aria-label="重试已跳过的任务 cad.png"]')).toBeNull();
});
