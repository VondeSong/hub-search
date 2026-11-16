// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {JournalToolbar} from "./JournalToolbar";
import {useJournalViewStore,type JournalViewStore} from "./JournalViews";
import {journalResultDates,journalUsesResultDays} from "./JournalFilter";

let host:HTMLDivElement,root:Root,store:JournalViewStore;
const click=async(selector:string)=>{await act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());};
const input=async(selector:string,value:string)=>{await act(async()=>{const field=host.querySelector<HTMLInputElement>(selector)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});};
function Fixture(){store=useJournalViewStore();return <JournalToolbar store={store} libraries={[{id:"os",name:"OS",provider:"obsidian",connected:true,documentCount:2,excludedPaths:[]},{id:"car",name:"Car",provider:"craft",connected:true,documentCount:1,excludedPaths:[]}]} resultCount={3} onUpdate={store.update}/>;}
beforeEach(async()=>{
 (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 localStorage.clear();
 Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.setAttribute("open","");}});
 Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.removeAttribute("open");}});
 const matches=Element.prototype.matches;
 vi.spyOn(Element.prototype,"matches").mockImplementation(function(this:Element,selector){return selector===":popover-open"?this.hasAttribute("data-open"):matches.call(this,selector);});
 Object.defineProperty(HTMLElement.prototype,"showPopover",{configurable:true,value:function(){this.setAttribute("data-open","");this.dispatchEvent(new Event("toggle"));}});
 Object.defineProperty(HTMLElement.prototype,"hidePopover",{configurable:true,value:function(){this.removeAttribute("data-open");this.dispatchEvent(new Event("toggle"));}});
 vi.spyOn(window,"requestAnimationFrame").mockImplementation(callback=>{callback(0);return 1;});
 host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Fixture/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});

it("keeps one controlled search when switching layouts and clears search without changing filters",async()=>{
 await click('[aria-label="搜索日志"]');await input('[aria-label="搜索日志内容"]',"历史");expect(store.view.query).toBe("历史");
 await act(async()=>store.update({layout:"records"}));expect(host.querySelectorAll('input[type="search"]')).toHaveLength(1);
 await click('[aria-label="清空并关闭日志搜索"]');expect(store.view.query).toBe("");expect(store.view.period).toBe("month");
});
it("distinguishes all libraries, explicit multi-selection, and an empty selection",async()=>{
 await click('.journal-filter-trigger');await click('[data-property="libraries"]');
 const checks=()=>host.querySelectorAll<HTMLInputElement>('.journal-library-options input');
 expect([...checks()].every(field=>!field.checked)).toBe(true);
 await act(async()=>checks()[0].click());expect(store.view.libraries).toEqual(["os"]);
 await act(async()=>checks()[1].click());expect(store.view.libraries).toEqual(["car","os"]);
 await act(async()=>{checks()[0].click();checks()[1].click();});expect(store.view.libraries).toEqual([]);expect(host.textContent).toContain("未选择资料库");
 await click('.journal-all-libraries');expect(store.view.libraries).toBeNull();
});
it("clears one condition independently and keeps search when clearing all conditions",async()=>{
 await act(async()=>store.update({query:"正文",recordFilter:"attachments",libraries:["os"]}));
 await click('[aria-label="移除筛选：内容类型：有附件"]');expect(store.view.recordFilter).toBe("all");expect(store.view.libraries).toEqual(["os"]);
 await click('.journal-clear-filters');expect(store.view.query).toBe("正文");expect(store.view.libraries).toBeNull();expect(store.view.period).toBe("all");
});
it("saves current filters in a naming dialog and updates or restores a saved view",async()=>{
 await act(async()=>store.update({query:"历史",period:"all"}));await click('[aria-label="新建日志视图"]');
 expect(host.querySelector('dialog')?.hasAttribute("open")).toBe(true);
 await input('[aria-label="新视图名称"]',"工作日志");await act(async()=>host.querySelector('.journal-save-view-dialog form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(store.saved[0].config.query).toBe("");expect(store.active?.name).toBe("工作日志");
 await act(async()=>store.update({query:"新词"}));expect(store.modified).toBe(false);
 await act(async()=>store.update({layout:"calendar"}));expect(store.modified).toBe(true);
 expect(host.querySelector('.journal-toolbar-actions .journal-view-persistence')).toBeNull();
 await click('.journal-view-persistence button:first-child');expect(store.active?.config.query).toBe("");expect(store.active?.config.layout).toBe("calendar");
 await act(async()=>store.update({query:"临时",layout:"list"}));await click('.journal-view-persistence button:last-child');expect(store.view.query).toBe("临时");expect(store.view.layout).toBe("calendar");
});
it("rejects duplicate view names without changing existing definitions",async()=>{
 await act(async()=>store.save("已有"));await click('[aria-label="新建日志视图"]');await input('[aria-label="新视图名称"]',"已有");
 await act(async()=>host.querySelector('.journal-save-view-dialog form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(store.saved).toHaveLength(1);expect(host.querySelector('[role="alert"]')?.textContent).toContain("同名");
});
it("returns focus to the filter trigger on Escape and synchronizes a changed civil date's month",async()=>{
 await click('.journal-filter-trigger');
 await act(async()=>host.querySelector('.journal-filter-popover')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(document.activeElement).toBe(host.querySelector('.journal-filter-trigger'));
 await act(async()=>store.update({period:"day",day:"2024-02-29",month:"2026-11"}));expect(store.view.month).toBe("2024-02");
 await click('[aria-label^="编辑筛选：日期"]');await input('[aria-label="筛选日期"]',"2024-03-01");expect(store.view.month).toBe("2024-03");
});
it("uses real matching civil dates in order and stays inside the selected month",()=>{
 const view={...store.view,month:"2024-02",query:"历史"};expect(journalUsesResultDays(view)).toBe(true);
 expect(journalResultDates(["2024-03-01","2024-02-29","2024-02-02","2024-02-29","invalid"],view)).toEqual(["2024-02-02","2024-02-29"]);
});

it("starts with only property choices and does not apply an unchosen date",async()=>{
 await act(async()=>store.update({period:"all"}));expect(host.querySelector('.journal-toolbar-conditions')).toBeNull();expect(host.querySelector('input[type="search"]')).toBeNull();
 await click('.journal-filter-trigger');expect(host.querySelectorAll('[data-property]')).toHaveLength(3);expect(host.querySelector('[aria-label="筛选日期"]')).toBeNull();
 await click('[data-property="period"]');await click('.journal-date-mode button:last-child');expect(store.view.period).toBe("all");expect(store.view.day).toBe("");
 await act(async()=>host.querySelector('.journal-filter-popover')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(host.querySelector('.journal-filter-popover')?.getAttribute('data-stage')).toBe("properties");
 await act(async()=>host.querySelector('.journal-filter-popover')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(host.querySelector('.journal-filter-trigger')?.getAttribute('aria-expanded')).toBe("false");
});
it("clears search and collapses it in two Escape steps without changing filters",async()=>{
 await click('[aria-label="搜索日志"]');await input('[aria-label="搜索日志内容"]',"历史");
 const press=()=>host.querySelector('input[type="search"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
 await act(async()=>press());expect(store.view.query).toBe("");expect(host.querySelector('input[type="search"]')).not.toBeNull();
 await act(async()=>press());expect(host.querySelector('input[type="search"]')).toBeNull();expect(store.view.period).toBe("month");expect(document.activeElement).toBe(host.querySelector('[aria-label="搜索日志"]'));
});
it("retains a disconnected saved library option until it is explicitly removed",async()=>{
 await act(async()=>store.update({libraries:["removed-library"]}));await click('[aria-label^="编辑筛选：资料库"]');
 const field=host.querySelector<HTMLInputElement>('.journal-library-options label:last-child input')!;expect(field.checked).toBe(true);
 await act(async()=>field.click());expect(store.view.libraries).toEqual([]);expect(host.textContent).toContain("未连接资料库");
});
