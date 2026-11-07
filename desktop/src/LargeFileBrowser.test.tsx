// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { LargeFileBrowser } from "./LargeFileBrowser";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
let host:HTMLDivElement,root:Root;
const entry={relativePath:"collection-files/hash/video.mp4",name:"video.mp4",bytes:300*1024*1024,categoryLabel:"阅读正文与附件原件",kind:"video",titles:["真实关联标题"],referenceCount:1};
const result={entries:[entry],totalFiles:1,totalBytes:entry.bytes,page:0,pageSize:50,warnings:[],readOnly:true};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;mocks.invoke.mockReset();mocks.invoke.mockImplementation(async (_c,a)=>a.args.action==="list_large_files"?result:{revealed:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const render=async()=>{await act(async()=>root.render(<LargeFileBrowser category="reading" rootPath={String.raw`\\?\C:\HubData`} onClose={()=>{}}/>));};
const button=(text:string)=>[...host.querySelectorAll("button")].find(v=>v.textContent===text)!;
it("loads exact category and shows associated title with size and a reveal action, no deletion",async()=>{
 await render();expect(mocks.invoke).toHaveBeenCalledWith("data_portability",{args:{action:"list_large_files",category:"reading",minimumBytes:50*1024*1024,kind:"all",query:"",page:0,operationId:expect.any(String)}});
 expect(host.textContent).toContain("真实关联标题");expect(host.textContent).toContain("300.0 MB");
 await act(async()=>button("定位文件").click());expect(mocks.invoke).toHaveBeenLastCalledWith("data_portability",{args:{action:"reveal_large_file",relativePath:entry.relativePath,operationId:expect.any(String)}});
 expect([...host.querySelectorAll("button")].some(v=>/删除|清理/.test(v.textContent||""))).toBe(false);
 expect(host.querySelector("code")?.textContent).toBe(String.raw`C:\HubData\collection-files\hash\video.mp4`);
});
it("changes the actual backend type filter and displays an empty result truthfully",async()=>{
 await render();mocks.invoke.mockResolvedValue({...result,entries:[],totalFiles:0,totalBytes:0});
 await act(async()=>{const e=host.querySelector('[aria-label="大文件类型"]') as HTMLSelectElement;e.value="pdf";e.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1]?.[1].args).toMatchObject({kind:"pdf",page:0});expect(host.textContent).toContain("没有符合条件的文件");
});
it("surfaces native errors without displaying stale results",async()=>{
 mocks.invoke.mockRejectedValue(new Error("文件扫描失败"));await render();expect(host.querySelector('[role="alert"]')?.textContent).toContain("文件扫描失败");expect(button("刷新列表")).toBeTruthy();expect(host.querySelectorAll(".large-file-list>li")).toHaveLength(0);
});
