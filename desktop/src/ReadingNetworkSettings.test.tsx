// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ReadingNetworkSettings } from "./ReadingNetworkSettings";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root, host: HTMLDivElement;
const state = {mode:"any",network:{supported:true,connected:true,kind:"cellular",metered:true,restricted:false},allowed:true,reason:""};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();invoke.mockResolvedValue(state);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(label:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===label)!;
it("shows native metered state and saves only the selected reading policy",async()=>{
  await act(async()=>root.render(<ReadingNetworkSettings/>));expect(host.textContent).toContain("移动网络 · 计费网络");expect(button("保存阅读网络策略").disabled).toBe(true);
  const select=host.querySelector("select")!;await act(async()=>{select.value="wifi";select.dispatchEvent(new Event("change",{bubbles:true}));});
  invoke.mockResolvedValue({...state,mode:"wifi",allowed:false,reason:"阅读传输已暂停：当前为计费网络"});await act(async()=>button("保存阅读网络策略").click());
  expect(invoke).toHaveBeenLastCalledWith("update_reading_network_policy",{mode:"wifi"});expect(host.textContent).toContain("阅读网络策略已保存");expect(host.textContent).toContain("阅读传输已暂停");expect(invoke.mock.calls.some(([c])=>c==="sync_reading"||c==="update_cloud_sync_policy")).toBe(false);
});
it("does not report saved settings before a pending transfer ends or after failure",async()=>{
  await act(async()=>root.render(<ReadingNetworkSettings/>));const select=host.querySelector("select")!;await act(async()=>{select.value="unmetered";select.dispatchEvent(new Event("change",{bubbles:true}));});
  let reject:(value:string)=>void=()=>{};invoke.mockImplementation(()=>new Promise((_,r)=>{reject=r;}));await act(async()=>button("保存阅读网络策略").click());expect(host.textContent).toContain("等待当前阅读传输结束");expect(host.textContent).not.toContain("已保存");await act(async()=>reject("无法保存"));expect(host.textContent).toContain("无法保存");expect(host.textContent).not.toContain("已保存");expect(host.querySelector("select")!.value).toBe("unmetered");
});
it("makes unavailable native capability and unknown network state visible",async()=>{
  invoke.mockResolvedValue({...state,mode:"wifi",network:{supported:false,kind:"unknown",connected:null,metered:null,restricted:false},allowed:false,reason:"无法确认当前网络"});await act(async()=>root.render(<ReadingNetworkSettings/>));expect(host.textContent).toContain("当前平台暂不能识别网络类型");expect(host.textContent).toContain("无法确认当前网络");
});
it("lets the user explicitly repair unreadable local settings without assuming a saved policy",async()=>{
  invoke.mockRejectedValue("阅读网络设置损坏，请重新保存");await act(async()=>root.render(<ReadingNetworkSettings/>));expect(host.textContent).toContain("尚未确认已保存的策略");expect(button("保存阅读网络策略").disabled).toBe(false);
  const select=host.querySelector("select")!;await act(async()=>{select.value="wifi";select.dispatchEvent(new Event("change",{bubbles:true}));});
  invoke.mockResolvedValue({...state,mode:"wifi",allowed:false,reason:"当前为计费网络"});await act(async()=>button("保存阅读网络策略").click());expect(invoke).toHaveBeenLastCalledWith("update_reading_network_policy",{mode:"wifi"});expect(host.textContent).toContain("阅读网络策略已保存");expect(host.textContent).not.toContain("设置损坏");
});
