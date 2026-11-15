// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickJournal } from "./QuickJournal";
import { journalEditorText } from "./JournalRichEditor";
import { defaultJournalView, localJournalDate, type JournalViewConfig } from "./JournalViews";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
let node: HTMLDivElement, root: Root;
const record = { version: 1, id: "a".repeat(32), date: "2026-11-07", text: "待保存 #想法", attachments: [] };
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "get_quick_journal_draft") return JSON.stringify(record);
    if (cmd === "get_quick_journal_settings") return { settings: { libraryId: "os", folder: "Journals", sync: false }, mobile: false };
    if (cmd === "list_quick_journal") return { items: [{ record, body: "OS 中手动修改后的正文", applied: true, uploaded: true, path: "daily", libraryId: "os", namespace: "" }], error: "" };
    if (cmd === "capture_quick_journal") return { warning: null };
  });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });
const render = async (dataVersion = "1") => { await act(async () => root.render(<QuickJournal libraries={[]} scope={null} dataVersion={dataVersion} view={{ ...defaultJournalView(), period: "all", layout: "records" }} />)); };
it("clears a recovered background sync error while preserving a failed local capture", async () => {
  const original = invoke.getMockImplementation()!;
  let remoteError = "OSS 下载中断；稍后可重试";
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === "list_quick_journal") return { ...await original(cmd, args), error: remoteError };
    if (cmd === "capture_quick_journal") throw new Error("本机保存失败，请重试");
    return original(cmd, args);
  });
  await render();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(remoteError);
  remoteError = "";
  await render("recovered");
  expect(node.querySelector('[role="alert"]')).toBeNull();
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("本机保存失败");
  await render("refreshed-again");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("本机保存失败");
  expect(node.querySelector("textarea")?.value).toBe(record.text);
});
it("restores a draft and displays each record's current Markdown without clock times", async () => {
  await render(); expect(node.querySelector("textarea")?.value).toBe(record.text);
  expect(node.querySelector("article")?.textContent).toContain("OS 中手动修改后的正文");
  expect(node.querySelector("article")?.textContent).toContain("2026-11-07");
  expect(node.querySelector("article")?.textContent).not.toMatch(/\d{2}:\d{2}/);
});
it("does not discard the draft when capture fails; retries reuse the same ID", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "capture_quick_journal" ? Promise.reject("磁盘写入失败") : original(cmd, args));
  await render();
  for (let i = 0; i < 2; i++) await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(node.querySelector("textarea")?.value).toBe(record.text);
  expect(invoke.mock.calls.filter(c => c[0] === "capture_quick_journal").map(c => c[1].record.id)).toEqual([record.id, record.id]);
  expect(node.textContent).toContain("磁盘写入失败");
});
it("clears only after durable capture and distinguishes local save from upload", async () => {
  await render();
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(node.querySelector("textarea")?.value).toBe("");
  expect(node.textContent).toContain("已保存到本机，可以锁屏");
  expect(invoke).toHaveBeenCalledWith("capture_quick_journal", { record });
});
const button = (text: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
it("blocks manual sync with unsaved settings, then reports the saved request result", async () => {
  await render();
  const checkbox = [...node.querySelectorAll("label")].find(l => l.textContent?.includes("开启本设备速记云同步"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => checkbox.click());
  expect(node.textContent).toContain("设置尚未保存");
  await act(async () => button("同步 / 重试").click());
  expect(invoke.mock.calls.filter(c => c[0] === "sync_quick_journal")).toHaveLength(0);
  expect(node.textContent).toContain("请先点击“保存设置”");
  await act(async () => button("保存设置").click());
  expect(node.textContent).not.toContain("设置尚未保存");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "sync_quick_journal" ? Promise.resolve({ pendingUpload: 0, awaitingOs: 1, written: 0 }) : original(cmd, args));
  await act(async () => button("同步 / 重试").click());
  expect(node.textContent).toContain("等待电脑写入 1 条");
});
it("shows a disabled gate error, exposes settings, and refreshes cards after partial failure", async () => {
  const original = invoke.getMockImplementation()!;
  let uploaded = false;
  invoke.mockImplementation((cmd: string, args: unknown) => {
    if (cmd === "sync_quick_journal") { uploaded = true; return Promise.reject("云同步总开关未开启"); }
    if (cmd === "list_quick_journal") return Promise.resolve({ items: [{ record, body: record.text, applied: false, uploaded, path: "", libraryId: "os" }], error: "" });
    return original(cmd, args);
  });
  await render(); await act(async () => button("同步 / 重试").click());
  expect(node.querySelector("[role=alert]")?.textContent).toContain("云同步总开关未开启");
  expect(node.querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
  expect(node.querySelector("article")?.textContent).toContain("已上传，等待电脑写入");
});
it("previews the record date in year/month mode and preserves a legacy fixed directory", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "get_quick_journal_settings" ? Promise.resolve({ settings: { libraryId: "os", folder: "Journals", sync: false, dateFolders: true }, mobile: false }) : original(cmd, args));
  await render(); expect(node.textContent).toContain("Journals/2026/11/2026-11-07.md");
  const toggle = [...node.querySelectorAll("label")].find(l => l.textContent?.includes("按记录日期分年/月目录"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => toggle.click());
  expect(node.textContent).toContain("Journals/2026-11-07.md");
  expect(node.textContent).toContain("固定目录，跨月时不会自动切换");
});
it("keeps loaded Markdown images mounted through expansion, parent updates and polling while showing OS edits", async () => {
  vi.useFakeTimers();
  const hash = "b".repeat(64), linkedHash = "c".repeat(64);
  let body = `${"正文".repeat(180)}\n\n![照片](_hub-assets/${hash}.jpg)\n\n[![链接图片](_hub-assets/${linkedHash}.jpg)](https://example.com)`;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: any) => {
    if (cmd === "quick_journal_image") return Promise.resolve(`data:image/jpeg;base64,${args.hash}`);
    if (cmd === "list_quick_journal") return Promise.resolve({ items: [{ record: { ...record }, body, applied: true, uploaded: true, path: "daily", libraryId: "os" }], error: "" });
    return original(cmd, args);
  });
  await render();
  const images = [...node.querySelectorAll("article img")];
  expect(images).toHaveLength(2);
  const reads = invoke.mock.calls.filter(c => c[0] === "quick_journal_image").length;
  await act(async () => button("展开全文").click());
  await render("2");
  body = body.replace("正文", "OS 中的新修改");
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  await act(async () => button("同步 / 重试").click());
  expect(node.querySelectorAll("article img")[0]).toBe(images[0]);
  expect(node.querySelectorAll("article img")[1]).toBe(images[1]);
  expect(invoke.mock.calls.filter(c => c[0] === "quick_journal_image")).toHaveLength(reads);
  expect(node.querySelector("article")?.textContent).toContain("OS 中的新修改");
  expect(button("收起").getAttribute("aria-expanded")).toBe("true");
});

const mobileSettings = () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd === "get_quick_journal_settings" ? Promise.resolve({settings:{libraryId:"",folder:"Journals",sync:true},mobile:true,cloudEnabled:true,autoSync:true}) : original(cmd,args));
};
const renderComposer=async(onSaved=vi.fn())=>{await act(async()=>root.render(<QuickJournal libraries={[]} scope={null} view={defaultJournalView()} dataVersion="mobile" mode="compose" onSaved={onSaved}/>));return onSaved;};
it("explains a paused automatic sync without promising background upload",async()=>{
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="get_quick_journal_settings"?Promise.resolve({settings:{libraryId:"",folder:"Journals",sync:true},mobile:true,cloudEnabled:true,autoSync:false}):original(cmd,args));
  await renderComposer();expect(node.querySelector(".quick-journal-capture-help")?.textContent).toContain("自动同步已暂停");
  expect(node.textContent).not.toContain("后台会继续上传");
  await act(async()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(node.textContent).toContain("自动同步已暂停");expect(invoke).not.toHaveBeenCalledWith("sync_quick_journal");
});
it("refocuses an already open tile composer without changing or saving its draft",async()=>{
  mobileSettings();await renderComposer();const input=node.querySelector<HTMLElement>('[role="textbox"]')!;
  input.blur();invoke.mockClear();
  await act(async()=>{window.dispatchEvent(new Event("hub:journal-capture-focus"));});
  expect(document.activeElement).toBe(input);expect(journalEditorText(input)).toBe(record.text);
  expect(invoke.mock.calls.map(call=>call[0])).toEqual(["focus_quick_journal_editor"]);
  await act(async()=>root.render(null));invoke.mockClear();
  window.dispatchEvent(new Event("hub:journal-capture-focus"));expect(invoke).not.toHaveBeenCalled();
});
it("focuses restored mobile input and navigates only after native capture and draft clearing",async()=>{
  mobileSettings(); let complete!:(value:unknown)=>void;
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="capture_quick_journal"?new Promise(resolve=>{complete=resolve;}):original(cmd,args));
  const saved=await renderComposer(); expect(document.activeElement).toBe(node.querySelector<HTMLElement>('[role="textbox"]'));
  expect(node.textContent).not.toContain("任务");expect(node.textContent).not.toContain("链接");
  await act(async()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(saved).not.toHaveBeenCalled();expect(journalEditorText(node.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(record.text);
  await act(async()=>complete({warning:null}));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({id:record.id,date:record.date}));
  expect(invoke).not.toHaveBeenCalledWith("sync_quick_journal");
  const writes=invoke.mock.calls.filter(c=>c[0]==="save_quick_journal_draft");const last=writes[writes.length-1];
  expect(JSON.parse(last[1].draft).text).toBe("");
});
it("retains an edited native draft after closing and reopening the mobile composer",async()=>{
  mobileSettings();let stored=JSON.stringify(record);const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd:string,args:any)=>{if(cmd==="get_quick_journal_draft")return Promise.resolve(stored);if(cmd==="save_quick_journal_draft"){stored=args.draft;return Promise.resolve();}return original(cmd,args);});
  await renderComposer();const input=node.querySelector<HTMLElement>('[role="textbox"]')!;
  await act(async()=>{input.textContent="关闭后继续写 #草稿";input.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>root.render(null));await renderComposer();
  expect(journalEditorText(node.querySelector<HTMLElement>('[role="textbox"]')!)).toBe("关闭后继续写 #草稿");
});
it("recovers a draft-read failure without replacing the saved draft",async()=>{
  mobileSettings();const original=invoke.getMockImplementation()!;let fail=true;
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="get_quick_journal_draft"&&fail?Promise.reject("读取失败"):original(cmd,args));
  await renderComposer();expect((node.querySelector<HTMLElement>('[role="textbox"]')!.getAttribute("contenteditable")==="false")).toBe(true);fail=false;
  await act(async()=>button("重新读取").click());expect(journalEditorText(node.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(record.text);expect((node.querySelector<HTMLElement>('[role="textbox"]')!.getAttribute("contenteditable")==="false")).toBe(false);
});
it("rejects oversized attachments before staging any bytes",async()=>{
  mobileSettings();await renderComposer();const file=new File(["x"],"big.pdf");Object.defineProperty(file,"size",{value:20*1024*1024+1});
  const picker=node.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,"files",{value:[file],configurable:true});
  await act(async()=>picker.dispatchEvent(new Event("change",{bubbles:true})));
  expect(node.textContent).toContain("超过 20 MB");expect(invoke.mock.calls.some(c=>c[0]==="stage_quick_journal_attachment")).toBe(false);expect(journalEditorText(node.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(record.text);
});
it("stages a file in native storage and allows an attachment-only mobile record",async()=>{
  mobileSettings();const original=invoke.getMockImplementation()!;const attachment={hash:"e".repeat(64),name:"记录.pdf",size:1,image:false};
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="get_quick_journal_draft"?Promise.resolve(JSON.stringify({...record,text:""})):cmd==="stage_quick_journal_attachment"?Promise.resolve(attachment):original(cmd,args));
  await renderComposer();const picker=node.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,"files",{value:[new File(["x"],attachment.name)],configurable:true});
  await act(async()=>{picker.dispatchEvent(new Event("change",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,25));});
  expect(node.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await act(async()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(invoke).toHaveBeenCalledWith("capture_quick_journal",{record:expect.objectContaining({text:"",attachments:[attachment]})});
});
it("searches local unfiled mobile records by date and filename, with pending and tag filters",async()=>{
  mobileSettings();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="list_quick_journal"?Promise.resolve({items:[{record:{...record,attachments:[{hash:"e".repeat(64),name:"现场.pdf",size:1,image:false}]},body:record.text,applied:false,uploaded:false,libraryId:"",path:""},{record:{...record,id:"b".repeat(32)},body:"已完成 #生活",applied:true,uploaded:true,libraryId:"os",path:"day"}],error:""}):original(cmd,args));
  function Feed(){const[view,setView]=useState<JournalViewConfig>({...defaultJournalView(),period:"all",layout:"records"});return <QuickJournal libraries={[]} scope={["os"]} view={view} dataVersion="1" mode="feed" onViewChange={change=>setView(v=>({...v,...change}))}/>;}
  await act(async()=>root.render(<Feed/>));expect(node.querySelectorAll("article")).toHaveLength(2);
  const search=node.querySelector<HTMLInputElement>('input[type="search"]')!;
  async function query(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,value);search.dispatchEvent(new Event("input",{bubbles:true}));});}
  await query("现场.pdf");expect(node.querySelectorAll("article")).toHaveLength(1);await query("2026-11-07");expect(node.querySelectorAll("article")).toHaveLength(2);
  await query("");await act(async()=>button("待同步").click());expect(node.querySelectorAll("article")).toHaveLength(1);
  expect(node.querySelector<HTMLElement>('[role="textbox"]')).toBeNull();expect(invoke.mock.calls.some(c=>c[0]==="get_quick_journal_draft")).toBe(false);
});

it("starts an empty restored mobile draft on today while preserving a dated nonempty draft",async()=>{
 mobileSettings();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="get_quick_journal_draft"?Promise.resolve(JSON.stringify({...record,text:""})):original(cmd,args));
 await renderComposer();await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="更多记录选项"]')!.click());
 expect(node.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe(localJournalDate());
});

it("retries a failed native draft write when saving again without requiring another edit",async()=>{
 mobileSettings();let fail=true;const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((cmd:string,args:unknown)=>cmd==="save_quick_journal_draft"&&fail?Promise.reject("暂时无法保存草稿"):original(cmd,args));
 await renderComposer();const input=node.querySelector<HTMLElement>('[role="textbox"]')!;
 await act(async()=>{input.textContent="可重试的草稿";input.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(journalEditorText(node.querySelector<HTMLElement>('[role="textbox"]')!)).toBe("可重试的草稿");expect(invoke.mock.calls.some(c=>c[0]==="capture_quick_journal")).toBe(false);
 fail=false;await act(async()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(invoke).toHaveBeenCalledWith("capture_quick_journal",{record:expect.objectContaining({id:record.id,text:"可重试的草稿"})});
});
it("waits for in-flight attachment staging when reopening the composer",async()=>{
 mobileSettings();let stored=JSON.stringify(record),finish!:(value:unknown)=>void;const original=invoke.getMockImplementation()!,attachment={hash:"e".repeat(64),name:"排查.txt",size:1,image:false};
 invoke.mockImplementation((cmd:string,args:any)=>{if(cmd==="get_quick_journal_draft")return Promise.resolve(stored);if(cmd==="save_quick_journal_draft"){stored=args.draft;return Promise.resolve();}if(cmd==="stage_quick_journal_attachment")return new Promise(resolve=>{finish=resolve;});return original(cmd,args);});
 await renderComposer();const picker=node.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,"files",{value:[new File(["x"],attachment.name)]});
 await act(async()=>{picker.dispatchEvent(new Event("change",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,25));});
 await act(async()=>root.render(null));await renderComposer();expect((node.querySelector<HTMLElement>('[role="textbox"]')!.getAttribute("contenteditable")==="false")).toBe(true);
 await act(async()=>finish(attachment));expect((node.querySelector<HTMLElement>('[role="textbox"]')!.getAttribute("contenteditable")==="false")).toBe(false);expect(node.textContent).toContain(attachment.name);
});
