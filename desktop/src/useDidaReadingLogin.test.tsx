// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDidaReadingLogin, type DidaReadingLoginStatus } from "./useDidaReadingLogin";
import type { WindowVisibility } from "./WindowVisibility";

const { invoke,listen }=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen}));
let root:Root,container:HTMLDivElement;
let open=vi.fn(async()=>{});
let options={authRequired:false,lastCheckedAt:100,syncError:"",latestAuthFailure:false};
const status=(overrides:Partial<DidaReadingLoginStatus>={}):DidaReadingLoginStatus=>({connected:false,accountMatched:false,checkedAt:200,loginWindowOpen:true,state:"authentication",message:"滴答网页登录未通过（401）；原项已保留",...overrides});
const success=()=>status({connected:true,accountMatched:true,state:"verified",message:"网页登录与账号绑定已核验"});
function Fixture(){
  const result=useDidaReadingLogin(options.authRequired,options.lastCheckedAt,options.syncError,options.latestAuthFailure,open);
  return <><output>{JSON.stringify({feedback:result.feedback,verified:result.currentVerified,latestSyncFailure:result.latestSyncFailure,busy:result.busy})}</output><button onClick={()=>void result.openLogin()} disabled={result.busy}>登录</button><button onClick={result.check} disabled={result.busy}>检查</button></>;
}
async function render(){await act(async()=>root.render(<Fixture/>));}
function data(){return JSON.parse(container.querySelector("output")!.textContent!);}
async function click(label:string){await act(async()=>Array.from(container.querySelectorAll("button")).find(button=>button.textContent===label)!.click());}
beforeEach(()=>{
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));
  invoke.mockReset();listen.mockReset();invoke.mockResolvedValue(status());open=vi.fn(async()=>{});
  options={authRequired:false,lastCheckedAt:100,syncError:"",latestAuthFailure:false};
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{
  await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.restoreAllMocks();
  Reflect.deleteProperty(window,"__TAURI_INTERNALS__");Reflect.deleteProperty(document,"hidden");
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("shows login-window acknowledgement as waiting and verifies only after the check response",async()=>{
  await render();await click("登录");
  expect(open).toHaveBeenCalledOnce();expect(invoke).not.toHaveBeenCalled();
  expect(data().feedback.phase).toBe("waiting");expect(data().feedback.message).toContain("不代表验证成功");
  invoke.mockResolvedValue(success());await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(data().feedback.phase).toBe("verified");expect(data().verified).toBe(true);
  expect(invoke).toHaveBeenCalledWith("get_dida_reading_login_status");
});

it("checks historical rejection once without polling or treating receipts as the current login",async()=>{
  options.authRequired=true;invoke.mockResolvedValue(success());await render();
  expect(data().verified).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(invoke).toHaveBeenCalledTimes(1);
});

it("keeps 401 as a waiting check while the login window is open and serializes requests",async()=>{
  let resolve!:(value:DidaReadingLoginStatus)=>void;
  invoke.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));
  await render();await click("登录");await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(data().busy).toBe(true);await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>resolve(status()));expect(data().feedback.phase).toBe("waiting");
  expect(data().feedback.status.message).toContain("401");
  invoke.mockResolvedValue(success());await click("检查");expect(data().verified).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(6000));expect(invoke).toHaveBeenCalledTimes(2);
});

it("distinguishes a temporary network failure from invalid credentials while waiting",async()=>{
  invoke.mockResolvedValue(status({state:"service-unavailable",message:"网络暂时无法连接"}));
  await render();await click("登录");await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(data().feedback.phase).toBe("waiting");expect(data().feedback.message).toContain("暂时无法连接");
  expect(data().feedback.message).not.toContain("登录失效");
  invoke.mockResolvedValue(success());await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(data().verified).toBe(true);
});

it("ends polling when the login window closes and reports account mismatch without fallback polling",async()=>{
  invoke.mockResolvedValue(status({loginWindowOpen:false}));await render();await click("登录");
  await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(data().feedback.phase).toBe("failed");
  await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue(status({state:"account-mismatch",message:"滴答授权与附件登录账号不一致，来源保留"}));
  await click("登录");await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(data().feedback.message).toContain("账号不一致");
  await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(invoke).toHaveBeenCalledTimes(2);
});

it("bounds automatic checks to two minutes and leaves manual verification available",async()=>{
  await render();await click("登录");await act(async()=>vi.advanceTimersByTimeAsync(120000));
  expect(data().feedback.phase).toBe("failed");expect(data().feedback.message).toContain("等待登录已结束");
  const calls=invoke.mock.calls.length;await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(invoke).toHaveBeenCalledTimes(calls);
  invoke.mockResolvedValue(success());await click("检查");expect(data().verified).toBe(true);
});

it("does not hide a fresh sync failure after a later successful user-status check",async()=>{
  options.authRequired=true;invoke.mockResolvedValue(success());await render();
  options={authRequired:true,lastCheckedAt:201,syncError:"任务内容读取未通过（401）；原项已保留",latestAuthFailure:true};await render();
  expect(data().feedback.phase).toBe("failed");expect(data().latestSyncFailure).toContain("任务内容读取未通过");
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue({...success(),checkedAt:202});await click("检查");
  expect(data().verified).toBe(true);expect(data().latestSyncFailure).toContain("401");
  options={authRequired:false,lastCheckedAt:203,syncError:"迁移核验完成",latestAuthFailure:false};await render();expect(data().latestSyncFailure).toBe("");
});

it("invalidates a waiting login request when a fresh sync failure arrives",async()=>{
  let resolve!:(value:DidaReadingLoginStatus)=>void;
  invoke.mockImplementation(()=>new Promise(value=>{resolve=value;}));
  await render();await click("登录");await act(async()=>vi.advanceTimersByTimeAsync(3000));
  options={authRequired:true,lastCheckedAt:201,syncError:"新同步返回401",latestAuthFailure:true};await render();
  await act(async()=>resolve({...success(),checkedAt:202}));
  expect(data().feedback.phase).toBe("failed");expect(data().verified).toBe(false);expect(data().latestSyncFailure).toBe("新同步返回401");
  await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(invoke).toHaveBeenCalledTimes(1);
});

it("does not treat an empty or non-authenticated new run as a fresh login rejection",async()=>{
  options.authRequired=true;invoke.mockResolvedValue(success());await render();
  options={authRequired:true,lastCheckedAt:201,syncError:"0 项迁移核验完成",latestAuthFailure:false};await render();
  expect(data().latestSyncFailure).toBe("");expect(data().feedback.phase).toBe("verified");
  expect(data().verified).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("removes an old sync-failure feedback block after a real successful run",async()=>{
  options.authRequired=true;invoke.mockResolvedValue(success());await render();
  options={authRequired:true,lastCheckedAt:201,syncError:"任务读取401",latestAuthFailure:true};await render();
  expect(data().feedback.message).toContain("最近一次同步核验未通过");
  options={authRequired:false,lastCheckedAt:202,syncError:"所有项目迁移核验完成",latestAuthFailure:false};await render();
  expect(data().latestSyncFailure).toBe("");expect(data().feedback.phase).toBe("idle");
  expect(data().feedback.message).not.toContain("同步核验未通过");
});

it("stops future checks on unmount",async()=>{
  await render();await click("登录");await act(async()=>root.unmount());
  await act(async()=>vi.advanceTimersByTimeAsync(150000));expect(invoke).not.toHaveBeenCalled();
  root=createRoot(container);
});

it("reports login-window creation failure and rejects malformed success replies",async()=>{
  open.mockRejectedValueOnce(new Error("窗口无法创建"));await render();await click("登录");
  expect(data().feedback.phase).toBe("failed");expect(data().feedback.message).toContain("窗口无法创建");
  invoke.mockResolvedValue({connected:true,message:"unsafe success"});await click("检查");
  expect(data().verified).toBe(false);expect(data().feedback.message).toContain("有效的滴答登录检查结果");
});

it("pauses automatic login checks on native hide and checks the actual connection once on restore",async()=>{
  Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
  const shown:WindowVisibility={revision:"1",visible:true,minimized:false,foreground:true};
  let deliver!:(event:{payload:WindowVisibility})=>void;const unlisten=vi.fn();
  listen.mockImplementation(async(_name,handler)=>{deliver=handler;return unlisten;});
  invoke.mockImplementation(async command=>command==="get_window_visibility"?shown:success());
  await render();await click("登录");
  await act(async()=>deliver({payload:{...shown,revision:"2",visible:false}}));
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
  const calls=()=>invoke.mock.calls.filter(([command])=>command==="get_dida_reading_login_status");
  expect(document.hidden).toBe(false);expect(calls()).toHaveLength(0);expect(open).toHaveBeenCalledOnce();
  await act(async()=>deliver({payload:{...shown,revision:"3"}}));
  expect(calls()).toHaveLength(1);expect(data().verified).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(calls()).toHaveLength(1);
  await act(async()=>root.render(null));expect(unlisten).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.every(([command])=>["get_window_visibility","get_dida_reading_login_status"].includes(command))).toBe(true);
});

it("does not extend the two-minute login deadline while minimized and retains manual verification after expiry",async()=>{
  Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
  const shown:WindowVisibility={revision:"1",visible:true,minimized:false,foreground:true};
  let deliver!:(event:{payload:WindowVisibility})=>void;
  listen.mockImplementation(async(_name,handler)=>{deliver=handler;return ()=>{};});
  invoke.mockImplementation(async command=>command==="get_window_visibility"?shown:status());
  await render();await click("登录");
  await act(async()=>deliver({payload:{...shown,revision:"2",minimized:true}}));
  await act(async()=>vi.advanceTimersByTimeAsync(125000));
  const calls=()=>invoke.mock.calls.filter(([command])=>command==="get_dida_reading_login_status");
  expect(calls()).toHaveLength(0);expect(open).toHaveBeenCalledOnce();
  await act(async()=>deliver({payload:{...shown,revision:"3"}}));
  expect(calls()).toHaveLength(1);expect(data().feedback.phase).toBe("failed");
  expect(data().feedback.message).toContain("等待登录已结束");
  await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(calls()).toHaveLength(1);
  invoke.mockImplementation(async command=>command==="get_window_visibility"?shown:success());
  await click("检查");expect(calls()).toHaveLength(2);expect(data().verified).toBe(true);
});
