// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { beforeEach,afterEach,it,expect,vi } from "vitest";
import { TagAssignmentExclusionReminder } from "./TagAssignmentExclusionReminder";
import { GlobalExclusionReviewNotice, GlobalExclusionReviewProvider, GlobalExclusionReviewSettings } from "./GlobalExclusionReviewReminder";
import { userProfileStorage } from "./UserProfileStorage";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;const open=vi.fn();
const render=(tagId="focus",revision=0)=>act(async()=>root.render(<TagAssignmentExclusionReminder tagId={tagId} days={90} revision={revision} onOpen={open}/>));
const tick=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-09T10:00:00Z"));Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);open.mockReset();invoke.mockReset().mockResolvedValue({count:2,hasMore:false,asOf:1});vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");vi.spyOn(document,"hidden","get").mockImplementation(()=>document.visibilityState==="hidden");});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
it("global reminder is opt-in, persists and opens governance",async()=>{
  await act(async()=>root.render(<TagAssignmentExclusionReminder global days={90} revision={0} onOpen={open}/>));expect(invoke).not.toHaveBeenCalled();
  await act(async()=>host.querySelector("input")!.click());expect(localStorage.getItem("hub.exclusion-review-global-reminder.v1")).toBe("enabled");expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>host.querySelector("button")!.click());expect(open).toHaveBeenCalledTimes(1);
  await act(async()=>root.render(null));await act(async()=>root.render(<TagAssignmentExclusionReminder global days={90} revision={0} onOpen={open}/>));expect(host.querySelector("input")!.checked).toBe(true);
  await act(async()=>host.querySelector("input")!.click());expect(localStorage.getItem("hub.exclusion-review-global-reminder.v1")).toBe("disabled");
});
it("global reminder honors shared preference changes and failed persistence",async()=>{
  localStorage.setItem("hub.exclusion-review-global-reminder.v1","enabled");
  await act(async()=>root.render(<TagAssignmentExclusionReminder global days={90} revision={0} onOpen={open}/>));expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>userProfileStorage.setItem("hub.exclusion-review-global-reminder.v1","disabled"));await tick(300000);expect(invoke).toHaveBeenCalledTimes(1);expect(host.querySelector("input")!.checked).toBe(false);
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("denied");});await act(async()=>host.querySelector("input")!.click());expect(host.textContent).toContain("仅本次生效");
});
it("checks locally at five-minute intervals and opens without writes",async()=>{
  await render();expect(invoke).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("有 2 条排除待复核");
  await act(async()=>host.querySelector("button")!.click());expect(open).toHaveBeenCalledTimes(1);
  await tick(299999);expect(invoke).toHaveBeenCalledTimes(1);await tick(1);expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.every(c=>c[1].args.action==="exclusion_review_due")).toBe(true);
  await act(async()=>host.querySelector("input")!.click());await tick(600000);expect(invoke).toHaveBeenCalledTimes(2);
});
it("skips hidden pages, refreshes on return and throttles focus",async()=>{
  vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");await render();await tick(300000);expect(invoke).not.toHaveBeenCalled();
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");await act(async()=>document.dispatchEvent(new Event("visibilitychange")));expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>window.dispatchEvent(new Event("focus")));expect(invoke).toHaveBeenCalledTimes(1);
  await tick(60000);await act(async()=>window.dispatchEvent(new Event("focus")));expect(invoke).toHaveBeenCalledTimes(2);
});
it("ignores old scopes and reports failures as unknown instead of zero",async()=>{
  let resolve!:(v:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await render();
  invoke.mockRejectedValueOnce(Error("offline"));await render("other");await act(async()=>resolve({count:10,hasMore:false,asOf:1}));
  expect(host.textContent).toContain("暂不可用");expect(host.textContent).not.toContain("有 10");expect(host.textContent).not.toContain("暂无待复核");
  invoke.mockResolvedValueOnce({count:1000,hasMore:true,asOf:1});await act(async()=>host.querySelector("button")!.click());expect(host.textContent).toContain("1000+");
  await render("other",1);expect(invoke).toHaveBeenLastCalledWith("tag_assignment",{args:{action:"exclusion_review_due",tag:"other",olderThanDays:90}});
});
it("does not poll a collapsed or offscreen surface",async()=>{
  let observe!:(entries:{isIntersecting:boolean}[])=>void;const disconnect=vi.fn();
  vi.stubGlobal("IntersectionObserver",class{constructor(callback:typeof observe){observe=callback;}observe(){}disconnect=disconnect;});
  await render();await tick(300000);expect(invoke).not.toHaveBeenCalled();
  await act(async()=>observe([{isIntersecting:true}]));expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>observe([{isIntersecting:false}]));await tick(300000);expect(invoke).toHaveBeenCalledTimes(1);
});
it("keeps global checks running when settings close and the sidebar unmounts", async () => {
  const app = (settings: boolean, sidebar: boolean) => <GlobalExclusionReviewProvider>
    {settings && <GlobalExclusionReviewSettings />}
    {sidebar && <GlobalExclusionReviewNotice onOpen={open} />}
  </GlobalExclusionReviewProvider>;
  await act(async () => root.render(app(true, true)));
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.sidebar-review-notice')?.textContent).toContain('排除待复核2');
  await act(async () => root.render(app(false, false)));
  await tick(300000);
  expect(invoke).toHaveBeenCalledTimes(2);
  await act(async () => root.render(app(false, true)));
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(host.querySelector('input, details, [role="switch"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.sidebar-review-notice')!.click());
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => root.render(app(true, true)));
  expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(host.querySelector('.sidebar-review-notice')).toBeNull();
  await tick(300000);
  expect(invoke).toHaveBeenCalledTimes(2);
});
it("hides an empty global result and offers retry on failure", async () => {
  localStorage.setItem('hub.exclusion-review-global-reminder.v1', 'enabled');
  invoke.mockResolvedValueOnce({ count: 0, hasMore: false, asOf: 1 });
  await act(async () => root.render(<GlobalExclusionReviewProvider><GlobalExclusionReviewNotice onOpen={open} /></GlobalExclusionReviewProvider>));
  expect(host.textContent).toBe('');
  invoke.mockRejectedValueOnce(Error('offline'));
  await tick(300000);
  expect(host.textContent).toContain('暂不可用');
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('排除待复核2');
  expect(open).not.toHaveBeenCalled();
});
it("does not start global checks outside the desktop runtime", async () => {
  localStorage.setItem('hub.exclusion-review-global-reminder.v1', 'enabled');
  await act(async () => root.render(<GlobalExclusionReviewProvider active={false}><span>mobile</span></GlobalExclusionReviewProvider>));
  await tick(600000);
  expect(invoke).not.toHaveBeenCalled();
});
