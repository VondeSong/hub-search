// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {JournalCaptureButton,JournalVoiceCapture,JournalAudio} from "./JournalVoice";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("./UserProfileStorage",()=>({userProfileStorage:{getItem:()=>null,setItem:vi.fn()}}));
let root:Root,host:HTMLDivElement;
const record={version:1 as const,id:"a".repeat(32),date:"2026-11-16",text:"已有文字",attachments:[]};
const attachment={hash:"b".repeat(64),name:"语音-5秒.m4a",size:1200,image:false};
const idle={state:"idle",elapsed:0,token:""};
let status:object;
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);status=idle;
 vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
  if(command==="quick_journal_voice_draft")return "";
  if(command==="quick_journal_voice")return args.action==="read"?attachment:args.action==="acknowledge"?(status=idle):status;
  if(command==="list_quick_journal")return {items:[{record,revision:"new-revision"}]};
  if(command==="update_quick_journal")return {revision:"new-revision"};
  return "";
 });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const click=async(text:string)=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent===text)!;expect(b).toBeTruthy();await act(async()=>b.click());};
it("long press opens voice once and suppresses the following text click",async()=>{
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});const voice=vi.fn();window.addEventListener("hub:journal-voice",voice);
 await act(async()=>root.render(<JournalCaptureButton/>));const button=host.querySelector("button")!;
 await act(async()=>{button.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0}));vi.advanceTimersByTime(501);button.dispatchEvent(new MouseEvent("pointerup",{bubbles:true}));button.click();});
 expect(voice).toHaveBeenCalledOnce();window.removeEventListener("hub:journal-voice",voice);
});
it("allows local recording without cloud service and labels it without attempting transcription",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="quick_journal_voice"&&a.action==="start"?Promise.resolve(status={state:"recording",elapsed:0,token:"f".repeat(32)}):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{}} onClose={vi.fn()}/>));await click("开始录音");
 expect(document.body.textContent).toContain("正在仅录音");expect(document.body.textContent).toContain("不会自动转写或发送给识别服务");
 expect(document.querySelector('[aria-label="转写服务"]')).toBeNull();expect(document.querySelector('[role="alert"]')).toBeNull();
 expect(vi.mocked(invoke).mock.calls.some(([c,a]:any)=>c==="cloud_agents"&&a?.action?.request?.action==="start")).toBe(false);
});
it("persists a staged original before acknowledgement and updates the same revision",async()=>{
 status={state:"ready",elapsed:5000,token:"c".repeat(32)};
 await act(async()=>root.render(<JournalVoiceCapture request={{record,revision:"old-revision"}} onClose={vi.fn()}/>));
 await click("保存");
 const calls=vi.mocked(invoke).mock.calls;
 const staged=calls.findIndex(([c,a]:any)=>c==="quick_journal_voice_draft"&&a?.value?.includes(attachment.hash));
 const ack=calls.findIndex(([c,a]:any)=>c==="quick_journal_voice"&&a.action==="acknowledge");
 expect(staged).toBeGreaterThan(-1);expect(ack).toBeGreaterThan(staged);
 expect(invoke).toHaveBeenCalledWith("update_quick_journal",expect.objectContaining({id:record.id,expectedRevision:"old-revision",record:{...record,attachments:[attachment]}}));
});
it("does not acknowledge or save when the durable audio draft fails",async()=>{
 status={state:"ready",elapsed:5000,token:"c".repeat(32)};
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="quick_journal_voice_draft"&&a?.value?.includes(attachment.hash)?Promise.reject("磁盘写入失败"):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{record}} onClose={vi.fn()}/>));await click("保存");
 expect(document.querySelector('[role="alert"]')?.textContent).toContain("磁盘写入失败");
 expect(vi.mocked(invoke).mock.calls.some(([c,a]:any)=>c==="quick_journal_voice"&&a.action==="acknowledge")).toBe(false);
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="capture_quick_journal")).toBe(false);
 vi.mocked(invoke).mockImplementation(original);await click("保存");
 expect(invoke).toHaveBeenCalledWith("capture_quick_journal",{record:{...record,attachments:[attachment]}});
});
it("ordinary save closes without creating or reopening another recording draft",async()=>{
 const close=vi.fn();
 await act(async()=>root.render(<JournalVoiceCapture request={{record}} onClose={close}/>));await click("保存");
 expect(invoke).toHaveBeenCalledWith("capture_quick_journal",{record});
 const writes=vi.mocked(invoke).mock.calls.filter(([c,a]:any)=>c==="quick_journal_voice_draft"&&a?.value);
 const last=JSON.parse((writes[writes.length-1]![1] as any).value);
 expect(last.record.id).toBe(record.id);expect(last.record.text).toBe(record.text);
 expect(close).toHaveBeenCalledOnce();
 expect(document.body.textContent).not.toContain("保存并录下一条");
});

it("short tap opens text and dragging cancels the long press",async()=>{
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});const text=vi.fn(),voice=vi.fn();window.addEventListener("hub:open-quick-journal",text);window.addEventListener("hub:journal-voice",voice);
 await act(async()=>root.render(<JournalCaptureButton/>));const b=host.querySelector("button")!;
 await act(async()=>{b.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0}));vi.advanceTimersByTime(100);b.dispatchEvent(new MouseEvent("pointerup",{bubbles:true}));b.click();vi.advanceTimersByTime(600);});
 expect(text).toHaveBeenCalledOnce();expect(voice).not.toHaveBeenCalled();
 await act(async()=>{b.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0}));b.dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:30}));vi.advanceTimersByTime(600);});
 expect(voice).not.toHaveBeenCalled();window.removeEventListener("hub:open-quick-journal",text);window.removeEventListener("hub:journal-voice",voice);
});

it("plays the custom audio control and pauses when the document hides",async()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
 const revoke=vi.fn(),create=vi.fn((_value:Blob)=>"blob:local-audio");vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:revoke});
 vi.mocked(invoke).mockResolvedValue("data:audio/mp4;base64,AAAA");
 await act(async()=>root.render(<JournalAudio attachment={attachment}/>));
 await act(async()=>host.querySelector("button")!.click());
 expect(play).toHaveBeenCalledOnce();expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
 expect(host.querySelector("audio")?.getAttribute("src")).toBe("blob:local-audio");expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
 vi.spyOn(document,"hidden","get").mockReturnValue(true);
 await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
 expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
 await act(async()=>root.render(null));expect(revoke).toHaveBeenCalledWith("blob:local-audio");
});
it("does not retain audio loaded after the card has closed",async()=>{
 const create=vi.fn();vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:vi.fn()});
 let finish!:(value:string)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise<string>(resolve=>{finish=resolve;}));
 await act(async()=>root.render(<JournalAudio attachment={attachment}/>));await act(async()=>host.querySelector("button")!.click());
 await act(async()=>root.render(null));await act(async()=>finish("data:audio/mp4;base64,AAAA"));
 expect(create).not.toHaveBeenCalled();
});

it("collapses original audio while keeping new segments separate on the same record",async()=>{
 const oldRecord={...record,attachments:[attachment]};
 const next={...attachment,hash:"d".repeat(64),name:"语音-3秒.m4a"};
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="quick_journal_voice"&&a.action==="read"?Promise.resolve(next):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{record:oldRecord,revision:"old-revision"}} onClose={vi.fn()}/>));
 expect(document.querySelector<HTMLDetailsElement>(".journal-voice-history")?.open).toBe(false);
 expect(document.querySelector(".journal-voice-segments")).toBeNull();
 status={state:"ready",elapsed:3000,token:"c".repeat(32)};
 await click("保存");
 expect(invoke).toHaveBeenCalledWith("update_quick_journal",expect.objectContaining({id:record.id,record:{...oldRecord,attachments:[attachment,next]}}));
 expect(document.querySelector(".journal-voice-segments")?.textContent).toContain("本次新增 · 1 段录音");
});
it("labels a restored draft and starts fresh only after explicit save-and-new",async()=>{
 let savedDraft=JSON.stringify({record:{...record,attachments:[attachment]},stagedTokens:[]});
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>{
  if(c==="quick_journal_voice_draft"){
   if(a?.recordId)return Promise.resolve("[]");
   if(a?.value!==undefined)savedDraft=a.value;
   return Promise.resolve(savedDraft);
  }
  return original(c,a);
 });
 const close=vi.fn();
 await act(async()=>root.render(<JournalVoiceCapture request={{}} onClose={close}/>));
 await click("继续 2026-11-16 的草稿 · 1 段录音");
 expect(document.body.textContent).toContain("已恢复上次未保存");
 expect(document.querySelector<HTMLDetailsElement>(".journal-voice-history")?.open).toBe(false);
 await click("保存并新建");
 expect(invoke).toHaveBeenCalledWith("capture_quick_journal",{record:{...record,attachments:[attachment]}});
 expect(close).not.toHaveBeenCalled();
 expect(document.querySelector(".journal-voice-segments")).toBeNull();
 const fresh=JSON.parse(savedDraft);expect(fresh.record.id).not.toBe(record.id);expect(fresh.record.attachments).toEqual([]);expect(fresh.record.text).toBe("");
 expect(document.body.textContent).not.toContain("已恢复上次未保存");
});

it("does not discard a restored draft when save-and-new fails",async()=>{
 const value=JSON.stringify({record:{...record,attachments:[attachment]},stagedTokens:[]});
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="capture_quick_journal"?Promise.reject("保存失败"):c==="quick_journal_voice_draft"&&!a?.value?Promise.resolve(value):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{}} onClose={vi.fn()}/>));
 await click("继续 2026-11-16 的草稿 · 1 段录音");
 await click("保存并新建");
 expect(document.querySelector('[role="alert"]')?.textContent).toContain("保存失败");
 expect(document.querySelector(".journal-voice-history")?.textContent).toContain("1 段录音");
 expect(vi.mocked(invoke).mock.calls.some(([c,a]:any)=>c==="quick_journal_voice_draft"&&a?.value==="")).toBe(false);
});
it("groups completed transcription under its original audio without duplicate replay",async()=>{
 const oldRecord={...record,attachments:[attachment]};
 const session={id:"transcript",recordId:record.id,source:attachment.hash,provider:"aliyun",binding:"cloud",state:"completed",text:"已校对",offset:1,audioHash:attachment.hash,applied:true};
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="quick_journal_voice_draft"&&a?.recordId?Promise.resolve(JSON.stringify([session])):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{record:oldRecord,revision:"old"}} onClose={vi.fn()}/>));
 expect(document.querySelector(".journal-voice-replay")).toBeNull();
 expect(document.querySelector<HTMLDetailsElement>(".journal-voice-history")?.open).toBe(false);
 expect(document.querySelector(".journal-voice-history .journal-transcript")?.textContent).toContain("已加入文字");
});

it("does not resurrect an unchanged saved record as a pending voice draft",async()=>{
 const close=vi.fn();
 await act(async()=>root.render(<JournalVoiceCapture request={{record:{...record,attachments:[attachment]},revision:"saved"}} onClose={close}/>));
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="保留语音草稿并关闭"]')!.click());
 expect(invoke).toHaveBeenCalledWith("quick_journal_voice_draft",{value:""});
 expect(close).toHaveBeenCalledOnce();
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="update_quick_journal")).toBe(false);
});

it("opens a fresh recording after an interrupted read-only visit to a saved record",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;
 const previous=JSON.stringify({record:{...record,attachments:[attachment]},revision:"saved",dirty:false,stagedTokens:[]});
 vi.mocked(invoke).mockImplementation((c,a:any)=>c==="quick_journal_voice_draft"&&!a?Promise.resolve(previous):original(c,a));
 await act(async()=>root.render(<JournalVoiceCapture request={{}} onClose={vi.fn()}/>));
 expect(document.querySelector(".journal-voice-segments")).toBeNull();
 expect(document.querySelector(".journal-voice-restored")).toBeNull();
 expect(document.querySelector<HTMLTextAreaElement>('[aria-label="录音补充文字"]')?.value).toBe("");
});

it("keeps an unrelated seven-segment draft parked while saving new audio to the current editor",async()=>{
 const previous={record:{...record,attachments:Array.from({length:7},(_,i)=>({...attachment,hash:String(i+1).repeat(64)}))},stagedTokens:[]};
 const target={...record,id:"e".repeat(32),text:"当前笔记的未保存文字"};
 let stored=JSON.stringify(previous);
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a:any)=>{
  if(c==="quick_journal_voice_draft"){
   if(a?.recordId)return Promise.resolve("[]");
   if(a?.value!==undefined)stored=a.value;
   return Promise.resolve(stored);
  }
  return original(c,a);
 });
 const onSave=vi.fn().mockResolvedValue(undefined),close=vi.fn();
 await act(async()=>root.render(<JournalVoiceCapture request={{record:target,revision:"edit-revision",onSave}} onClose={close}/>));
 expect(document.querySelector<HTMLTextAreaElement>('[aria-label="录音补充文字"]')?.value).toBe(target.text);
 expect(document.querySelectorAll(".journal-audio")).toHaveLength(0);
 expect(document.querySelector<HTMLDetailsElement>(".journal-voice-history")?.open).toBe(false);
 expect(JSON.parse(stored).pendingDrafts[0]).toEqual(previous);
 status={state:"ready",elapsed:5000,token:"c".repeat(32)};
 await click("保存");
 expect(onSave).toHaveBeenCalledWith({...target,attachments:[attachment]});
 expect(close).toHaveBeenCalledOnce();
 expect(JSON.parse(stored).pendingDrafts[0]).toEqual(previous);
 expect(vi.mocked(invoke).mock.calls.some(([c])=>["update_quick_journal","capture_quick_journal","cloud_agents"].includes(c))).toBe(false);
});
it("never requests cloud access in local mode even when a provider was previously selected",async()=>{
 await act(async()=>root.render(<JournalVoiceCapture request={{}} onClose={vi.fn()}/>));
 expect(document.querySelector<HTMLSelectElement>('[aria-label="录音方式"]')?.value).toBe("local");
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="cloud_agents")).toBe(false);
 const select=document.querySelector<HTMLSelectElement>('[aria-label="录音方式"]')!;
 await act(async()=>{select.value="transcribe";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(document.querySelector('[aria-label="转写服务"]')).not.toBeNull();
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="cloud_agents")).toBe(true);
});
