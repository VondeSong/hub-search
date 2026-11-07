// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { DidaReadingResolutions } from "./DidaReadingResolutions";
import { ReadingLegacyReservation } from "./ReadingLegacyReservation";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let root:Root,host:HTMLDivElement;
const item={key:"dida:one",title:"稍后读资料",snapshot:"version1",error:"正文版本不一致",state:"pending",updatedAt:123};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const click=async(name:string)=>{await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent===name)!.click());};
const openHistory=async()=>{await act(async()=>{const details=host.querySelector<HTMLDetailsElement>(".collection-dida-resolution-history")!;details.open=true;details.dispatchEvent(new Event("toggle"));});};
it("retains both copies only on explicit selection and allows resuming checks",async()=>{
 let preserved=false;const retry=vi.fn();
 invoke.mockImplementation(async (command,args)=>{if(command==="resolve_dida_reading"){preserved=args.preserve;return;}return [{...item,...(preserved?{state:"preserved",error:"用户选择保留两边内容，已结束自动清理"}:{})}];});
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={retry}/>));
 expect(invoke).not.toHaveBeenCalled();await click("处理保留的原内容");
 await click("保留两边，结束此项处理");
 expect(invoke).toHaveBeenCalledWith("resolve_dida_reading",{key:item.key,snapshot:item.snapshot,error:item.error,updatedAt:123,preserve:true});
 expect(retry).not.toHaveBeenCalled();expect(host.querySelector('[aria-label="待处理原内容"]')?.textContent).toContain("没有待处理的原内容");
 expect(host.querySelector<HTMLDetailsElement>(".collection-dida-resolution-history")?.open).toBe(false);
 expect(host.querySelectorAll(".collection-dida-resolution-item")).toHaveLength(0);
 await openHistory();
 await click("恢复自动检查");expect(retry).toHaveBeenCalledOnce();
});
it("does not announce completion or trigger retry when a stale decision is rejected",async()=>{
 const retry=vi.fn();invoke.mockImplementation(async command=>{if(command==="resolve_dida_reading")throw "状态已变化";return [item];});
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={retry}/>));
 await click("处理保留的原内容");await click("重新读取并检查");
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("状态已变化");expect(retry).not.toHaveBeenCalled();expect(host.textContent).not.toContain("已恢复检查");
});
it("separates already ended history from an attachment-inventory issue and opens its source",async()=>{
 const open=vi.fn();const sourceUrl="https://dida365.com/webapp/#p/reference/tasks/one";
 const missing={...item,title:"[虽然这么说很糟糕](https://mp.weixin.qq.com/s?long=query)",error:"滴答没有返回附件列表，暂时保留原内容",reasonKind:"attachment-list-unavailable",sourceUrl};
 const saved={...item,key:"dida:two",title:"[[TBOX]资料](https://example.invalid/a(b))",state:"preserved",error:"用户选择保留两边内容，已结束自动清理",sourceUrl};
 invoke.mockResolvedValue([missing,saved]);
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={vi.fn()} onOpenUrl={open} pendingCount={1} preservedCount={1}/>));
 await click("处理保留的原内容 · 1 项待处理");
 expect(host.querySelector('[aria-label="待处理原内容"]')?.querySelectorAll("article")).toHaveLength(1);
 expect(host.querySelector(".collection-dida-resolution-heading>strong")?.textContent).toBe("虽然这么说很糟糕");
 expect(host.textContent).not.toContain("long=query");
 expect(host.textContent).toContain("无法确认有无附件");
 expect(host.querySelector<HTMLDetailsElement>(".collection-dida-resolution-history")?.open).toBe(false);
 await click("查看滴答原内容");expect(open).toHaveBeenCalledWith(sourceUrl);
 await openHistory();expect(host.querySelector(".is-history strong")?.textContent).toBe("[TBOX]资料");
});
it("removes a successfully ended item from pending even when refreshing fails",async()=>{
 let decided=false;invoke.mockImplementation(async command=>{
  if(command==="resolve_dida_reading"){decided=true;return;}
  if(decided)throw "暂时无法刷新记录";
  return [item];
 });
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={vi.fn()} pendingCount={1}/>));
 await click("处理保留的原内容 · 1 项待处理");await click("保留两边，结束此项处理");
 expect(host.querySelector('[role="status"]')?.textContent).toContain("这条已结束处理");
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂时无法刷新记录");
 expect(host.querySelector('[aria-label="待处理原内容"]')?.querySelectorAll("article")).toHaveLength(0);
 expect(host.querySelector('.collection-dida-resolutions>button')?.textContent).toBe("处理保留的原内容");
});
it("refreshes when a sync ends but never changes an item without a user decision",async()=>{
 const retry=vi.fn();invoke.mockResolvedValue([item]);
 await act(async()=>root.render(<DidaReadingResolutions busy={true} onRetry={retry}/>));
 await click("处理保留的原内容");expect(invoke).not.toHaveBeenCalled();
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={retry}/>));
 expect(invoke).toHaveBeenCalledWith("list_dida_reading_resolutions");
 expect(invoke.mock.calls.some(([command])=>command==="resolve_dida_reading")).toBe(false);
});
it("does not finish an item when its decision is rejected",async()=>{
 invoke.mockImplementation(async command=>{if(command==="resolve_dida_reading")throw "状态已变化";return [item];});
 await act(async()=>root.render(<DidaReadingResolutions busy={false} onRetry={vi.fn()}/>));
 await click("处理保留的原内容");await click("保留两边，结束此项处理");
 expect(host.querySelector('[aria-label="待处理原内容"]')?.querySelectorAll("article")).toHaveLength(1);
 expect(host.querySelector('[role="status"]')).toBeNull();
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("状态已变化");
});
it("releases only the displayed legacy reservation after explicit action",async()=>{
 let released=false;const retry=vi.fn();
 invoke.mockImplementation(async command=>{if(command==="release_reading_legacy_reservation"){released=true;return;}return {day:"2026-10-09",legacyReservedBytes:released?0:1048576};});
 await act(async()=>root.render(<ReadingLegacyReservation onRetry={retry}/>));
 expect(invoke.mock.calls.some(([c])=>c==="release_reading_legacy_reservation")).toBe(false);
 await click("释放旧版预留");expect(invoke).toHaveBeenCalledWith("release_reading_legacy_reservation",{day:"2026-10-09",bytes:1048576});
 expect(host.textContent).toContain("已释放旧版预留");expect(retry).not.toHaveBeenCalled();await click("重新同步滴答稍后读");expect(retry).toHaveBeenCalledOnce();
});
