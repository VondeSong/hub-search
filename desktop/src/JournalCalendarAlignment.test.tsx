// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JournalRecordCard } from "./JournalRecordCard";
import type { SearchResult } from "./SearchTypes";
import { JournalCapturePanel } from "./JournalCapturePanel";
import { JournalRecordsProvider, journalHeatLevel } from "./JournalRecords";
import { JournalNavigation } from "./JournalNavigation";
import { JournalViewsContext, defaultJournalView, useJournalViewStore, type JournalViewStore } from "./JournalViews";
import { insertJournalTask,splitJournalCapture } from "./JournalCapture";
import { isInsideKeyboardDialog } from "./AppKeyboardScope";

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save:vi.fn()}));
vi.mock("@tauri-apps/plugin-opener",()=>({openUrl:vi.fn()}));
let host:HTMLDivElement,root:Root,store:JournalViewStore;
const drafts=new Map<string,string>();
const libraries=[{id:"os",name:"OS",provider:"obsidian" as const,connected:true,documentCount:1,excludedPaths:[]}];
function Editor(){const [day,setDay]=useState("2026-11-15");return <><button aria-label="补记另一天" onClick={()=>setDay("2026-11-16")}/><JournalCapturePanel libraries={libraries} day={day} onDay={setDay} dataVersion="v1" scope={null} view={defaultJournalView()}/></>;}
function Nav(){store=useJournalViewStore();return <JournalViewsContext.Provider value={store}><JournalRecordsProvider enabled dataVersion="v1" scope={null}><JournalNavigation dates={[]} selectedDate="2026-11-15" onSelectDate={()=>{}}/></JournalRecordsProvider></JournalViewsContext.Provider>;}
async function click(selector:string){await act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());}
async function text(value:string){await act(async()=>{const input=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();drafts.clear();host=document.createElement("div");document.body.append(host);root=createRoot(host);
 invoke.mockReset().mockImplementation(async(command:string,args:any)=>{
  if(command==="get_quick_journal_draft")return drafts.get(args?.slot||"default")||"";
  if(command==="save_quick_journal_draft"){drafts.set(args?.slot||"default",args.draft);return;}
  if(command==="get_quick_journal_settings")return {settings:{libraryId:"os",folder:"Journals",sync:false},mobile:false};
  if(command==="journal_record_index")return [];
  if(command==="list_quick_journal")return {items:[{record:{version:1,id:"a".repeat(32),date:"2026-11-15",text:"记录",attachments:[{hash:"b".repeat(64),name:"图.png",size:1,image:true}]},body:"记录",libraryId:"os",path:"",uploaded:false,applied:false}],error:""};
  return {warning:null};
 });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});

it("restores separate day drafts after minimizing without creating a record",async()=>{
 await act(async()=>root.render(<Editor/>));await text("15 日尚未创建");await click('[aria-label="收起日志草稿"]');
 expect(host.querySelector("textarea")).toBeNull();expect(invoke.mock.calls.some(([cmd])=>cmd==="capture_calendar_journal")).toBe(false);
 await click('[aria-label="补记另一天"]');await text("16 日草稿");await click('[aria-label="收起日志草稿"]');
 await click('[aria-label="继续编辑 2026-11-15 的日志草稿"]');expect(host.querySelector('textarea')?.value).toBe("15 日尚未创建");
 expect(JSON.parse(drafts.get("2026-11-16")!).text).toBe("16 日草稿");
});
it("gives Escape to the open journal editor before the app can hide the window",async()=>{
 await act(async()=>root.render(<Editor/>));await text("Esc 后保留的草稿");
 const hide=vi.fn();const capture=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!isInsideKeyboardDialog(event.target))hide();};
 window.addEventListener("keydown",capture,true);
 try {
  await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true,cancelable:true})));
  expect(host.querySelector('textarea')).not.toBeNull();
  await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(hide).not.toHaveBeenCalled();expect(host.querySelector('textarea')).toBeNull();
  await click('[aria-label="继续编辑 2026-11-15 的日志草稿"]');expect(host.querySelector('textarea')?.value).toBe("Esc 后保留的草稿");
 } finally {window.removeEventListener("keydown",capture,true);}
});
it("only explicit creation captures, and a failure retains the same durable identity",async()=>{
 await act(async()=>root.render(<Editor/>));await text("需要保留的正文");
 const original=invoke.getMockImplementation()!;invoke.mockImplementation(async(cmd:string,args:any)=>{if(cmd==="capture_calendar_journal")throw new Error("磁盘暂不可写");return original(cmd,args);});
 const submit=()=>act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await submit();await submit();const calls=invoke.mock.calls.filter(([cmd])=>cmd==="capture_calendar_journal");expect(calls).toHaveLength(2);expect(calls[0][1].record.id).toBe(calls[1][1].record.id);expect(host.querySelector('textarea')?.value).toBe("需要保留的正文");
});
it("inserts task syntax in the same editor and requires an explicit real destination",async()=>{
 await act(async()=>root.render(<Editor/>));await click('[aria-label="插入任务"]');await text("日志\n- [ ] 办事");
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("请选择任务保存到");expect(invoke.mock.calls.some(([cmd])=>cmd==="capture_calendar_journal")).toBe(false);
 expect(host.querySelector('[aria-label="任务资料库"]')).not.toBeNull();
});
it("counts records rather than libraries and links quick filters to the shared view",async()=>{
 await act(async()=>root.render(<Nav/>));expect(host.querySelector('[data-date="2026-11-15"]')?.getAttribute('data-count')).toBe("1");
 const attachments=[...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="日志常用筛选"] button')].find(b=>b.textContent?.includes("有附件"))!;
 await act(async()=>attachments.click());expect(store.view.recordFilter).toBe("attachments");expect(attachments.getAttribute('aria-pressed')).toBe("true");
 await act(async()=>attachments.click());expect(store.view.recordFilter).toBe("all");
});
it("shares the prototype heat thresholds and preserves fenced task examples",()=>{
 expect([0,1,2,3,4,5,50,NaN].map(journalHeatLevel)).toEqual([0,1,2,3,3,4,4,0]);
 expect(splitJournalCapture("正文\n- [ ] 做事\n```md\n- [ ] 示例\n```\n- [x] 已做")).toEqual({text:"正文\n```md\n- [ ] 示例\n```",tasks:[{title:"做事",completed:false},{title:"已做",completed:true}]});
 expect(insertJournalTask("前后",1,1)).toEqual({text:"前\n- [ ] \n后",caret:8});
});

it("copies complete source text instead of the calendar excerpt",async()=>{
 const entry={id:"doc",entityKey:"doc",documentId:"doc",libraryId:"os",spaceId:"os",libraryName:"OS",provider:"obsidian",title:"2026-11-15",journalDate:"2026-11-15",snippet:"摘要"} as SearchResult;
 const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
 const original=invoke.getMockImplementation()!;invoke.mockImplementation(async(cmd:string,args:any)=>cmd==="local_document"?"完整原文，超出摘要部分":original(cmd,args));
 await act(async()=>root.render(<JournalRecordCard entry={entry} onPreview={()=>{}}/>));
 const copy=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==="复制来源全文")!;await act(async()=>copy.click());
 expect(writeText).toHaveBeenCalledWith("完整原文，超出摘要部分");expect(invoke).toHaveBeenCalledWith("local_document",expect.objectContaining({spaceId:"os",documentId:"doc"}));
});

it("keeps a bare task marker as a draft instead of reporting an empty creation",async()=>{
 await act(async()=>root.render(<Editor/>));await text("- [ ] ");
 expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(invoke.mock.calls.some(([cmd])=>cmd==="capture_calendar_journal")).toBe(false);expect(host.querySelector('textarea')?.value).toBe("- [ ] ");
});

it("does not count the source container again for a represented quick record",async()=>{
 const original=invoke.getMockImplementation()!;invoke.mockImplementation(async(cmd:string,args:any)=>cmd==="journal_record_index"?[{id:'["os","daily"]',date:"2026-11-15",libraryId:"os",documentId:"daily",hasAttachments:false,hasTags:false,representedByQuick:true}]:original(cmd,args));
 await act(async()=>root.render(<Nav/>));expect(host.querySelector('[data-date="2026-11-15"]')?.getAttribute('data-count')).toBe("1");
});

it("recognizes the same Unicode whitespace task marker as the native parser",()=>{
 expect(splitJournalCapture("-　[ ] 中文任务")).toEqual({text:"",tasks:[{title:"中文任务",completed:false}]});
 expect(splitJournalCapture("-\t[x] 完成任务")).toEqual({text:"",tasks:[{title:"完成任务",completed:true}]});
});

it("keeps a save receipt visible after the editor closes",async()=>{
 await act(async()=>root.render(<Editor/>));await text("创建的正文");await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('textarea')).toBeNull();expect(host.querySelector('.journal-capture-notice')?.textContent).toContain("创建完成");expect(host.querySelector('.journal-draft-dock')?.textContent).not.toContain("11月15日");
});
