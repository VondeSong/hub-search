// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ReadingCopies } from "./ReadingCopies";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true; host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset(); });
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("distinguishes local receipts and remote read-only metadata without write or open controls",async()=>{
  invoke.mockResolvedValue([{device:"a",deviceLabel:"Windows · desktop",local:false,observedAt:1700000000,copies:[{id:"one",provider:"obsidian",name:"学习库",state:"saved"}]},{device:"b",deviceLabel:"Android · phone",local:true,observedAt:null,copies:[{id:"two",provider:"craft",name:"Main",state:"partial"}]}]);
  await act(async()=>root.render(<ReadingCopies itemKey="article"/>));
  expect(host.textContent).toContain("Windows · desktop");expect(host.textContent).toContain("本机");expect(host.textContent).toContain("附件待补齐");expect(host.textContent).toContain("不保证副本包含最新正文");
  expect(host.querySelectorAll("button,a,input,select").length).toBe(0);
  expect(invoke.mock.calls.every(([command])=>command==="reading_copy_status")).toBe(true);
});
it("discards stale responses after changing the selected article",async()=>{
  let resolve!:(value:unknown)=>void;
  invoke.mockImplementation((_command,args)=>args.key==="old"?new Promise(r=>{resolve=r;}):Promise.resolve([]));
  await act(async()=>root.render(<ReadingCopies itemKey="old"/>));
  await act(async()=>root.render(<ReadingCopies itemKey="new"/>));
  await act(async()=>resolve([{device:"a",deviceLabel:"过期设备",local:false,copies:[{id:"old",name:"旧副本",provider:"craft",state:"saved"}]}]));
  expect(host.textContent).toBe("");
});
it("withdraws removed metadata on reading refresh and reports read errors without changing the article",async()=>{
  invoke.mockResolvedValue([{device:"a",deviceLabel:"电脑",local:false,observedAt:1,copies:[{id:"a",provider:"obsidian",name:"资料库",state:"missing"}]}]);
  await act(async()=>root.render(<ReadingCopies itemKey="article"/>));expect(host.textContent).toContain("未找到文件");
  invoke.mockResolvedValue([]);await act(async()=>window.dispatchEvent(new Event("hub:reading-data-changed")));expect(host.textContent).toBe("");
  invoke.mockRejectedValue("读取失败");await act(async()=>window.dispatchEvent(new Event("hub:reading-data-changed")));expect(host.textContent).toContain("暂不可用");
});
