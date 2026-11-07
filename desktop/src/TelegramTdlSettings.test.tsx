// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const { invokeMock }=vi.hoisted(()=>({invokeMock:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:invokeMock}));
import { TelegramTdlSettings, type TelegramTdlState } from "./TelegramTdlSettings";
let root:Root,host:HTMLDivElement;
const state:TelegramTdlState={installed:true,version:"0.20.4",enabled:true,ready:true,running:false,phase:"",status:"",bytes:0,proxy:""};
beforeEach(()=>{vi.clearAllMocks();invokeMock.mockResolvedValue("完成");host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("explicitly discards incomplete files while preserving completed attachments",async()=>{
  const reload=vi.fn().mockResolvedValue(undefined);
  await act(async()=>root.render(<TelegramTdlSettings state={state} paired reload={reload} onError={()=>{}}/>));
  const button=[...host.querySelectorAll("button")].find(b=>b.textContent==="取消未完成的附件下载")!;
  await act(async()=>button.click());
  expect(invokeMock).toHaveBeenCalledWith("discard_partial_media_downloads",undefined);
  expect(reload).toHaveBeenCalledOnce();expect(host.textContent).toContain("暂停保留续传数据");
});
it("waits for an active download to stop before allowing discard",async()=>{
  await act(async()=>root.render(<TelegramTdlSettings state={{...state,running:true,phase:"download"}} paired reload={async()=>{}} onError={()=>{}}/>));
  const button=[...host.querySelectorAll("button")].find(b=>b.textContent==="取消未完成的附件下载")!;
  expect(button.disabled).toBe(true);button.click();expect(invokeMock).not.toHaveBeenCalled();
});
