// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TelegramTdlLogin } from "./TelegramTdlLogin";
import type { WindowVisibility } from "./WindowVisibility";
const {invoke,listen}=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen}));
let container:HTMLDivElement, root:Root;
const reload=vi.fn(async()=>{});
const initial={sessionId:21,active:true,qr:["00000","01110","01010","01110","00000"],qrAt:0,needsPassword:false,status:"请扫描"};
let view=initial;
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-06T03:00:00Z"));view={...initial,qrAt:Date.now()};
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
 container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);invoke.mockImplementation(async(name:string)=>name==="get_telegram_tdl_login"?view:"");
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();invoke.mockReset();reload.mockClear();listen.mockReset();Reflect.deleteProperty(window,"__TAURI_INTERNALS__");vi.restoreAllMocks();});
async function mount(){await act(async()=>root.render(<TelegramTdlLogin running={true} reload={reload}/>));}
async function click(text:string){const button=[...container.querySelectorAll("button")].find(b=>b.textContent===text)!;expect(button).toBeTruthy();await act(async()=>button.click());}
it("shows square QR modules, updates the token and hides stale images",async()=>{
 await mount();expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
 const qr=container.querySelector<SVGElement>('[aria-label="Telegram 登录二维码"]')!;
 expect(qr.getAttribute("viewBox")).toBe("0 0 5 5");expect(qr.getAttribute("shape-rendering")).toBe("crispEdges");
 expect(qr.querySelectorAll('rect[fill="#000"]')).toHaveLength(8);
 await act(async()=>vi.advanceTimersByTimeAsync(25_001));expect(container.querySelector('[aria-label="Telegram 登录二维码"]')).toBeNull();
 view={...view,sessionId:22,qrAt:Date.now(),qr:["000","010","000"]};await act(async()=>vi.advanceTimersByTimeAsync(500));
 expect(container.querySelector('[aria-label="Telegram 登录二维码"]')?.getAttribute("viewBox")).toBe("0 0 3 3");
 expect(container.textContent).toContain("设置 → 设备 → 连接桌面设备");
});
it("refreshes the exact active login and cancels it on Escape",async()=>{
 await mount();await click("重新获取二维码");expect(invoke).toHaveBeenCalledWith("login_telegram_tdl",{method:"qr",replace:21});
 await act(async()=>vi.advanceTimersByTimeAsync(500));
 await act(async()=>container.querySelector("dialog")!.dispatchEvent(new Event("cancel",{bubbles:true,cancelable:true})));
 expect(invoke).toHaveBeenCalledWith("cancel_telegram_tdl");expect(container.querySelector<HTMLDialogElement>("dialog")!.open).toBe(false);
 expect(container.querySelector('[aria-label="Telegram 登录二维码"]')).toBeNull();
});
it("sends a two-step password only to its login session and immediately clears the field",async()=>{
 view={...view,needsPassword:true,qr:[]};await mount();
 const field=container.querySelector<HTMLInputElement>("#tdl-password")!;expect(field.type).toBe("password");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"LOCAL_TEST_ONLY");field.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(invoke).toHaveBeenCalledWith("submit_telegram_tdl_password",{sessionId:21,password:"LOCAL_TEST_ONLY"});
 expect(field.value).toBe("");expect(container.textContent).not.toContain("LOCAL_TEST_ONLY");expect(localStorage.length).toBe(0);
});
it("retains a retry action and shows errors when a new QR cannot start",async()=>{
 await mount();invoke.mockImplementation(async(name:string)=>{if(name==="login_telegram_tdl")throw "连接失败，请检查代理";return view;});
 await click("重新获取二维码");expect(container.querySelector('[role="alert"]')?.textContent).toContain("检查代理");
 const button=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="重新扫码登录")!;expect(button.disabled).toBe(false);
});

it("stops login status reads on native minimize, reads the current session on restore and releases its timer on unmount",async()=>{
 Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
 vi.spyOn(document,"hidden","get").mockReturnValue(false);
 let visibility!:(event:{payload:WindowVisibility})=>void;const unlisten=vi.fn();
 const shown:WindowVisibility={revision:"1",visible:true,minimized:false,foreground:true};
 listen.mockImplementation(async(_name,handler)=>{visibility=handler;return unlisten;});
 invoke.mockImplementation(async(name:string)=>name==="get_window_visibility"?shown:name==="get_telegram_tdl_login"?view:"");
 await mount();const reads=()=>invoke.mock.calls.filter(([name])=>name==="get_telegram_tdl_login").length;
 expect(reads()).toBe(1);
 await act(async()=>visibility({payload:{...shown,revision:"2",minimized:true}}));
 view={...view,sessionId:22,qrAt:Date.now(),qr:["000","010","000"]};
 await act(async()=>vi.advanceTimersByTimeAsync(5000));expect(reads()).toBe(1);
 expect(invoke).not.toHaveBeenCalledWith("cancel_telegram_tdl");
 await act(async()=>visibility({payload:{...shown,revision:"3"}}));expect(reads()).toBe(2);
 expect(container.querySelector('[aria-label="Telegram 登录二维码"]')?.getAttribute("viewBox")).toBe("0 0 3 3");
 await act(async()=>root.render(null));await act(async()=>vi.advanceTimersByTimeAsync(5000));
 expect(reads()).toBe(2);expect(unlisten).toHaveBeenCalledOnce();
});
