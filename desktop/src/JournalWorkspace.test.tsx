// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { JournalWorkspace } from "./JournalWorkspace";
import { JournalViewsContext,useJournalViewStore } from "./JournalViews";
import type { JournalViewStore } from "./JournalViews";
import type { SearchResult } from "./SearchTypes";
import { pageFavoriteKey } from "./PageFavorites";
const record=(source:string,id:string)=>({id,entityKey:`document:${source}:${id}`,documentId:id,provider:"craft",spaceId:source,libraryId:source,libraryName:source,contentType:"document",sourceType:"craft_page",spaceName:source,path:"未分类",matchField:"",matchCount:0,title:"2026-10-07",journalDate:"2026-10-07",snippet:"设计复盘与来源证据",matchTerms:[],subMatches:[]}) as SearchResult;
const items=[record("Car","a"),record("Private","b")];
const page={items,total:2,days:1,libraries:2,revision:"v1",loading:false,error:"",retry:vi.fn(),loadMore:vi.fn()};
vi.mock("./useJournalPage",()=>({useJournalPage:()=>page}));
vi.mock("./JournalDailyData",()=>({canSetJournalTaskStatus:()=>false,useJournalDailyData:()=>({tasksByDate:new Map(),taskBusyIds:new Set(),tasksLoading:false,tasksError:"",retry:vi.fn(),setTaskCompleted:vi.fn()})}));
let container:HTMLDivElement,root:Root,store:JournalViewStore;
const preview=vi.fn(),open=vi.fn(),create=vi.fn(),favorite=vi.fn();
function Fixture(){store=useJournalViewStore();return <JournalViewsContext.Provider value={store}><JournalWorkspace libraries={[{id:"Car",name:"Car",provider:"craft",connected:true,documentCount:1,excludedPaths:[]}]} scope={null} dataVersion="v1" selectedDate="" onPreview={preview} onOpen={open} onCreate={create} onFavorite={favorite} favoriteIds={new Set([pageFavoriteKey(items[0])])} renderIcon={()=>null}/></JournalViewsContext.Provider>;}
async function click(selector:string){await act(async()=>container.querySelector<HTMLButtonElement>(selector)!.click());}
beforeEach(()=>{(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.setAttribute("open","");}});Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.removeAttribute("open");}});vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(2026,9,13,12));container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);preview.mockClear();open.mockClear();create.mockClear();favorite.mockClear();});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();});
describe("Journal database workspace",()=>{
 it("keeps same-day sources separate and previews the original page; favorite uses page identity",async()=>{
  await act(async()=>root.render(<Fixture/>));await act(async()=>store.update({layout:"calendar"}));await click('[aria-label="2026年10月7日 · 周三，2条记录"]');expect(container.querySelectorAll(".journal-entry-card")).toHaveLength(2);
  await click('.journal-entry-card:first-child .journal-entry-open');expect(preview).toHaveBeenLastCalledWith(items[0]);
  expect(container.querySelector('.journal-entry-actions button')?.getAttribute("aria-pressed")).toBe("true");
  await click('.journal-entry-actions button');expect(favorite).toHaveBeenLastCalledWith(items[0]);
  await click('.journal-entry-actions button:last-child');expect(open).toHaveBeenLastCalledWith(items[0]);
 });
 it("selects a calendar date without narrowing the date filter, then explicitly filters that day",async()=>{
  await act(async()=>root.render(<Fixture/>));await act(async()=>store.update({layout:"calendar"}));
  await click('[aria-label="2026年10月7日 · 周三，2条记录"]');expect(store.view.period).toBe("month");
  expect(container.querySelectorAll('.journal-month-cell')).toHaveLength(35);
  const filter=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='仅看这一天')!;
  await act(async()=>filter.click());expect(store.view.period).toBe("day");expect(store.view.day).toBe("2026-10-07");
 });
 it("creates a saved view without touching source pages and restores its layout",async()=>{
  await act(async()=>root.render(<Fixture/>));await act(async()=>store.update({layout:"table",source:false,summary:false}));
  await click('[aria-label="新建日志视图"]');
  await act(async()=>{const input=container.querySelector<HTMLInputElement>('.journal-save-view-dialog input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'工作日志');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>container.querySelector('.journal-save-view-dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(store.saved[0].name).toBe("工作日志");expect(store.saved[0].config.layout).toBe("table");
  await act(async()=>{store.update({layout:"list"});});expect(store.modified).toBe(true);
  await act(async()=>store.select(store.saved[0].id));expect(store.view.layout).toBe("table");
  await act(async()=>store.remove(store.saved[0].id));expect(store.saved).toHaveLength(0);expect(open).not.toHaveBeenCalled();
 });
 it("starts with the full-width composer and keeps backfill in the selected day",async()=>{
  await act(async()=>root.render(<Fixture/>));
  const dates=[...container.querySelectorAll<HTMLElement>('[data-journal-day]')].map(row=>row.dataset.journalDay);
  expect(dates[0]).toBe('2026-10-13');expect(dates[dates.length-1]).toBe('2026-10-06');
  expect(container.querySelector('.journal-inline-editor-top textarea')).not.toBeNull();
  expect(container.querySelector('.journal-empty-range')).toBeNull();
  await click('.journal-daily-day.is-today .journal-daily-add');
  expect(container.querySelector('.journal-daily-day.is-today .journal-inline-editor-day time')?.textContent).toBe('2026-10-13');
  await click('[data-journal-day="2026-10-12"] .journal-daily-add');
  expect(container.querySelector('[data-journal-day="2026-10-12"] .journal-inline-editor-day time')?.textContent).toBe('2026-10-12');
  expect(container.querySelector('.journal-floating-editor')).toBeNull();
  await click('.journal-inline-cancel');
  expect(container.querySelector('.journal-inline-editor-day')).toBeNull();
  expect(container.querySelector('.journal-inline-editor-top textarea')).not.toBeNull();
  expect(create).not.toHaveBeenCalled();
 });
});
