// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ReadingOffline, type ReadingOfflinePlan } from "./ReadingOffline";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root, host: HTMLDivElement;
const plan: ReadingOfflinePlan = {token:"snapshot",postHash:"body",total:2,available:0,retained:0,downloadBytes:1048576,actionable:1,complete:false,warnings:[],previous:"",items:[{url:"https://example.invalid/photo.png",state:"download",bytes:1048576,reason:"待下载、校验并保留"},{url:"https://example.invalid/video.mp4",state:"excluded",bytes:12345,reason:"未包含音视频/ZIP，或超过当前大小限制"}]};
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (name:string) => [...host.querySelectorAll("button")].find(b=>b.textContent===name)!;
it("requires an explicit bounded preview before downloading and defaults to excluding large formats",async()=>{
  invoke.mockResolvedValue(plan); await act(async()=>root.render(<ReadingOffline itemKey="article"/>));expect(invoke).not.toHaveBeenCalled();
  await act(async()=>button("检查离线范围").click());expect(invoke).toHaveBeenCalledWith("preview_reading_offline",{key:"article",includeExtras:false});expect(host.textContent).toContain("1.0 MB");expect(invoke.mock.calls.some(([c])=>c==="download_reading_offline")).toBe(false);
  invoke.mockResolvedValue({succeeded:1,failures:["每日额度不足"],plan:{...plan,available:1,retained:1,previous:"partial"}});
  await act(async()=>button("下载并保留可用附件").click());expect(invoke).toHaveBeenCalledWith("download_reading_offline",{key:"article",includeExtras:false,token:"snapshot"});expect(host.textContent).toContain("仍有未完成内容");expect(host.textContent).toContain("每日额度不足");expect(host.textContent).not.toContain("已通过离线检查");
});
it("invalidates preview when optional video policy changes and discards rejected stale plans",async()=>{
  invoke.mockResolvedValue(plan);await act(async()=>root.render(<ReadingOffline itemKey="a"/>));await act(async()=>button("检查离线范围").click());
  await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(button("下载并保留可用附件")).toBeUndefined();await act(async()=>button("检查离线范围").click());expect(invoke).toHaveBeenLastCalledWith("preview_reading_offline",{key:"a",includeExtras:true});
  invoke.mockRejectedValue("正文已变化，请重新检查");await act(async()=>button("下载并保留可用附件").click());expect(button("下载并保留可用附件")).toBeUndefined();expect(host.textContent).toContain("正文已变化");
});
it("ignores old article responses and exposes interruption and incomplete-body reasons",async()=>{
  let resolve:(value:ReadingOfflinePlan)=>void=()=>{};invoke.mockImplementation(()=>new Promise(r=>{resolve=r;}));await act(async()=>root.render(<ReadingOffline itemKey="a"/>));await act(async()=>button("检查离线范围").click());await act(async()=>root.render(<ReadingOffline itemKey="b"/>));await act(async()=>resolve({...plan,complete:true}));expect(host.textContent).not.toContain("可离线使用");
  invoke.mockResolvedValue({...plan,previous:"interrupted",warnings:["正文仍可能不完整"]});await act(async()=>button("检查离线范围").click());expect(host.textContent).toContain("上次下载被中断");expect(host.textContent).toContain("正文仍可能不完整");
});
it("shows verified completion only from the backend and refreshes attachment consumers",async()=>{
  invoke.mockResolvedValue(plan);const refreshed=vi.fn();window.addEventListener("hub:reading-attachment-ready",refreshed);
  await act(async()=>root.render(<ReadingOffline itemKey="a"/>));await act(async()=>button("检查离线范围").click());invoke.mockResolvedValue({succeeded:2,failures:[],plan:{...plan,complete:true,available:2,retained:2,actionable:0}});
  await act(async()=>button("下载并保留可用附件").click());expect(host.textContent).toContain("已通过离线检查");expect(refreshed).toHaveBeenCalledTimes(1);expect(button("下载并保留可用附件")).toBeUndefined();window.removeEventListener("hub:reading-attachment-ready",refreshed);
});
