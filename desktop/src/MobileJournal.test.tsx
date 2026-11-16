// @vitest-environment jsdom
import {act} from "react";import{createRoot,type Root}from"react-dom/client";import{beforeEach,afterEach,it,expect,vi}from"vitest";
import{MobileJournal}from"./MobileJournal";import type{QuickJournalItem}from"./JournalRecords";
const invoke=vi.fn(),saved=new Map<string,string>();
vi.mock("@tauri-apps/api/core",()=>({invoke:(...args:unknown[])=>invoke(...args)}));
vi.mock("./UserProfileStorage",()=>({userProfileStorage:{getItem:(key:string)=>saved.get(key)||null,setItem:(key:string,value:string)=>saved.set(key,value)}}));
let root:Root,node:HTMLElement,items:QuickJournalItem[],drafts:Map<string,string>;
const wait=()=>new Promise(r=>setTimeout(r,35));
const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.getAttribute("aria-label")===name||b.textContent===name)!;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;node=document.createElement("div");document.body.append(node);root=createRoot(node);saved.clear();drafts=new Map();window.history.replaceState({hubMobileRoute:"journals"},"");HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};items=[{record:{version:1,id:"a".repeat(32),date:"2026-11-15",text:"原记录 #日常",attachments:[]},body:"原记录 #日常",applied:true,uploaded:true,libraryId:"os",path:"",namespace:"ns",revision:"b".repeat(64)}];invoke.mockReset();invoke.mockImplementation(async(cmd:string,args:any)=>{
 if(cmd==="list_quick_journal")return {items:structuredClone(items),error:""};
 if(cmd==="get_quick_journal_settings")return {settings:{sync:true},cloudEnabled:true,autoSync:true,error:""};
 if(cmd==="get_quick_journal_draft")return drafts.get(args.slot)||"";
 if(cmd==="save_quick_journal_draft"){drafts.set(args.slot,args.draft);return;}
 if(cmd==="update_quick_journal"){if(args.expectedRevision!==items[0].revision)throw new Error("version conflict");items[0]={...items[0],record:args.record,body:args.record.text,revision:"c".repeat(32),deleted:args.deleted,applied:false,uploaded:false};return{revision:items[0].revision};}
 if(cmd==="quick_journal_history")return {revision:items[0].revision,versions:[{record:{...items[0].record,text:"历史正文"},revision:"old",createdAt:null,deleted:false}]};
});});
afterEach(async()=>{await act(async()=>{root.unmount();await wait();});node.remove();vi.restoreAllMocks();vi.unstubAllGlobals();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
async function render(){await act(async()=>root.render(<MobileJournal onBack={()=>{}} onInsights={()=>{}}/>));}
async function edit(){await act(async()=>(document.querySelector('[aria-label="编辑这条记录"]') as HTMLElement).click());await act(async()=>wait());}
it("can leave a loading old-record editor without clearing or submitting its retained draft",async()=>{
 const retained=JSON.stringify({record:{...items[0].record,text:"尚未读完的原草稿"},revision:items[0].revision});drafts.set(`edit:${items[0].record.id}`,retained);
 const original=invoke.getMockImplementation()!;let complete!:(value:string)=>void;
 invoke.mockImplementation((cmd:string,args:any)=>cmd==="get_quick_journal_draft"?new Promise<string>(resolve=>{complete=resolve;}):original(cmd,args));
 await render();await edit();
 await act(async()=>{document.querySelector('dialog[aria-label="编辑日志"]')!.dispatchEvent(new Event("cancel",{cancelable:true}));complete(retained);await wait();});
 expect(document.querySelector('[aria-label="编辑日志"]')).toBeNull();expect(drafts.get(`edit:${items[0].record.id}`)).toBe(retained);
 expect(invoke.mock.calls.some(c=>["save_quick_journal_draft","update_quick_journal"].includes(c[0]))).toBe(false);
});
it("keeps sync and retry on the journal page and exposes all twelve record actions",async()=>{
 await render();await act(async()=>button("速记同步状态").click());expect(document.querySelector("dialog")?.textContent).toContain("保存后自动尝试上传");await act(async()=>button("同步 / 重试").click());expect(invoke).toHaveBeenCalledWith("sync_quick_journal");
 await act(async()=>{button("关闭").click();await wait();});await act(async()=>button("记录操作 2026-11-15").click());
 for(const label of ["分享","编辑","复制","置顶","加入浮窗","相关笔记","查看详情","历史版本","复制链接","批注","设定日期","删除"])expect(button(label)).toBeTruthy();
});
it("saves old-record changes using the original ID and revision, without creating a new capture",async()=>{
 await render();await edit();const input=document.querySelector<HTMLElement>('[role="textbox"]')!;
 await act(async()=>{input.textContent="修改后的正文";input.dispatchEvent(new Event("input",{bubbles:true}));});
 expect(drafts.get(`edit:${items[0].record.id}`)).toContain("修改后的正文");
 await act(async()=>{button("保存修改并返回").click();await wait();});
 expect(invoke).toHaveBeenCalledWith("update_quick_journal",{id:"a".repeat(32),expectedRevision:"b".repeat(64),record:expect.objectContaining({id:"a".repeat(32),text:"修改后的正文",date:"2026-11-15"}),deleted:false});
 expect(invoke.mock.calls.some(c=>c[0]==="capture_quick_journal")).toBe(false);expect(document.querySelector('[aria-label="编辑日志"]')).toBeNull();expect(items).toHaveLength(1);
});
it("keeps the editor and native draft after a failed save",async()=>{
 await render();await edit();const original=invoke.getMockImplementation()!;invoke.mockImplementation((cmd:string,args:any)=>cmd==="update_quick_journal"?Promise.reject("OS版本变化"):original(cmd,args));
 const input=document.querySelector<HTMLElement>('[role="textbox"]')!;await act(async()=>{input.textContent="不能丢的草稿";input.dispatchEvent(new Event("input",{bubbles:true}));});await act(async()=>button("保存修改并返回").click());
 expect(document.querySelector('[aria-label="编辑日志"]')).not.toBeNull();expect(document.querySelector('[role="alert"]')?.textContent).toContain("OS版本变化");expect(drafts.get(`edit:${items[0].record.id}`)).toContain("不能丢的草稿");expect(items[0].record.text).toBe("原记录 #日常");
});
it("cancelling a file picker keeps a changed old record open without saving it",async()=>{
 await render();await edit();const input=document.querySelector<HTMLElement>('[role="textbox"]')!;
 await act(async()=>{input.textContent="选图取消后继续写";input.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>{document.querySelector('dialog input[type="file"]')!.dispatchEvent(new Event("cancel",{bubbles:true}));await wait();});
 expect(document.querySelector('[aria-label="编辑日志"]')).not.toBeNull();
 expect(invoke.mock.calls.some(c=>c[0]==="update_quick_journal")).toBe(false);expect(drafts.get(`edit:${items[0].record.id}`)).toContain("选图取消后继续写");
});
it("restores a real history snapshot through a new version instead of deleting history",async()=>{
 await render();await act(async()=>button("记录操作 2026-11-15").click());await act(async()=>button("历史版本").click());const version=[...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(b=>b.textContent?.includes("版本 0"))!;await act(async()=>version.click());await act(async()=>{button("恢复此版本").click();await wait();});
 expect(invoke).toHaveBeenCalledWith("update_quick_journal",expect.objectContaining({id:"a".repeat(32),record:expect.objectContaining({text:"历史正文"})}));expect(items).toHaveLength(1);
});
it("refuses to overwrite a changed record from a stale saved edit draft",async()=>{
 drafts.set(`edit:${"a".repeat(32)}`,JSON.stringify({record:{...items[0].record,text:"旧草稿"},revision:"old"}));await render();await edit();await act(async()=>button("保存修改并返回").click());
 expect(invoke.mock.calls.some(c=>c[0]==="update_quick_journal")).toBe(false);expect(document.querySelector('[aria-label="编辑日志"]')).not.toBeNull();expect(drafts.get(`edit:${"a".repeat(32)}`)).toContain("旧草稿");
});
it("keeps a remotely rejected edit readable and copyable without replacing the OS version",async()=>{
 items[0].sourceError="CONFLICT:OS正文已变化";
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((cmd:string,args:any)=>cmd==="quick_journal_history"?Promise.resolve({revision:items[0].revision,versions:[],conflicts:[{record:{...items[0].record,text:"电脑拒绝后仍保留的完整正文"},revision:"conflict",createdAt:1,deleted:false,error:"CONFLICT:OS正文已变化"}]}):original(cmd,args));
 const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal("navigator",{...navigator,clipboard:{writeText}});
 await render();await act(async()=>button("查看未同步修改").click());await act(async()=>[...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(b=>b.textContent?.startsWith("查看保留的内容"))!.click());
 expect(document.querySelector("dialog")?.textContent).toContain("电脑拒绝后仍保留的完整正文");
 await act(async()=>button("复制这份内容").click());expect(writeText).toHaveBeenCalledWith("电脑拒绝后仍保留的完整正文");
 expect(button("恢复此版本")).toBeUndefined();expect(invoke.mock.calls.some(c=>c[0]==="update_quick_journal")).toBe(false);
 vi.unstubAllGlobals();
});
it("opens a separate search view with no feed until a query or preset is selected, then returns to the feed",async()=>{
 await render();await act(async()=>button("搜索日志").click());
 expect(document.querySelector('[aria-label="搜索日志正文"]')).not.toBeNull();expect(document.querySelectorAll(".mobile-journal-card")).toHaveLength(0);
 await act(async()=>button("无标签").click());expect(document.querySelectorAll(".mobile-journal-card")).toHaveLength(0);
 await act(async()=>{button("取消").click();await wait();});expect(document.querySelector('[aria-label="搜索日志正文"]')).toBeNull();expect(document.querySelectorAll(".mobile-journal-card")).toHaveLength(1);
 expect(invoke.mock.calls.some(c=>c[0]==="update_quick_journal")).toBe(false);
});
it("rejects reversed dates before applying a search filter",async()=>{
 await render();await act(async()=>button("搜索日志").click());await act(async()=>button("展开日志筛选").click());await act(async()=>button("日期").click());
 const form=document.querySelector<HTMLFormElement>(".mobile-journal-filter-form")!;
 form.querySelector<HTMLInputElement>('[name="start"]')!.value="2026-11-17";form.querySelector<HTMLInputElement>('[name="end"]')!.value="2026-11-15";
 await act(async()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(form.querySelector('[role="alert"]')?.textContent).toContain("结束日期不能早于");expect(invoke.mock.calls.some(c=>c[0]==="update_quick_journal")).toBe(false);
});
it("replaces a custom date range when a preset is selected",async()=>{
 await render();await act(async()=>button("搜索日志").click());await act(async()=>button("展开日志筛选").click());await act(async()=>button("日期").click());
 const form=document.querySelector<HTMLFormElement>(".mobile-journal-filter-form")!;
 form.querySelector<HTMLInputElement>('[name="start"]')!.value="2026-11-01";form.querySelector<HTMLInputElement>('[name="end"]')!.value="2026-11-15";
 await act(async()=>form.querySelector<HTMLInputElement>('input[value="month"]')!.click());
 expect(form.querySelector<HTMLInputElement>('[name="start"]')!.value).toBe("");expect(form.querySelector<HTMLInputElement>('[name="end"]')!.value).toBe("");
});
it("preserves failed batch selections and does not resubmit already updated records",async()=>{
 const second={...structuredClone(items[0]),record:{...items[0].record,id:"d".repeat(32),text:"第二条",date:"2026-11-14"}};items.push(second);
 const original=invoke.getMockImplementation()!;let rejectSecond=true;
 invoke.mockImplementation(async(cmd:string,args:any)=>{if(cmd!=="update_quick_journal")return original(cmd,args);if(args.id===second.record.id&&rejectSecond)throw new Error("版本已变化");const target=items.findIndex(i=>i.record.id===args.id);expect(args.expectedRevision).toBe(items[target].revision);items[target]={...items[target],record:args.record,revision:"new-"+args.id,deleted:args.deleted};});
 await render();await act(async()=>button("日志").click());await act(async()=>{button("选择笔记").click();await wait();});
 await act(async()=>button("选择记录 2026-11-15").click());await act(async()=>button("选择记录 2026-11-14").click());await act(async()=>button("添加标签").click());
 const form=document.querySelector<HTMLFormElement>('dialog form')!;form.querySelector<HTMLInputElement>('[name="tags"]')!.value="#批量";
 await act(async()=>{form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await wait();});
 expect(items[0].record.text).toContain("#批量");expect(items[1].record.text).toBe("第二条");expect(document.querySelector("dialog")?.textContent).toContain("版本已变化");
 rejectSecond=false;await act(async()=>{form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await wait();});
 expect(invoke.mock.calls.filter(c=>c[0]==="update_quick_journal"&&c[1].id===items[0].record.id)).toHaveLength(1);expect(items[1].record.text).toBe("第二条\n#批量");expect(items).toHaveLength(2);
});
