// @vitest-environment jsdom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {JournalTranscript,useJournalTranscription,type Transcript} from "./JournalTranscription";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let root:Root,host:HTMLDivElement,api:ReturnType<typeof useJournalTranscription>,items:Transcript[],remote:Transcript,events:string[],connection="original",reset:(value:Transcript[])=>void;
const source="a".repeat(32);
function Harness({initial=[],recordId="record"}:{initial?:Transcript[];recordId?:string}){
 const [sessions,setSessions]=useState(initial);items=sessions;reset=setSessions;
 api=useJournalTranscription({ready:true,recordId,sessions,onChange:async v=>{events.push("persist:"+v.id);setSessions(old=>old.some(s=>s.id===v.id)?old.map(s=>s.id===v.id?v:s):[...old,v]);}});
 return null;
}
beforeEach(async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;events=[];connection="original";host=document.createElement("div");document.body.append(host);root=createRoot(host);
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
  if(command==="quick_journal_voice")return {audio:"AAAA",next:2,total:2,closed:true};
  const request=args.action.request;
  if(args.action.op==="config")return {binding:connection};
  if(request.action==="providers")return {providers:[{id:"aliyun",model:"paraformer-realtime-v2",configured:true},{id:"openai",model:"gpt-live-transcribe",configured:true}]};
  events.push(request.action+":"+(request.job||""));
  if(request.action==="start")return remote={id:request.job,recordId:"record",source:request.source,provider:request.provider,binding:connection,state:"running",text:"",offset:0};
  if(request.action==="read")return remote;
  if(request.action==="append")return remote={...remote,offset:2,text:"识别中的文字"};
  if(request.action==="finish")return remote={...remote,state:"completed",text:"最终文字"};
  return remote;
 });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.clearAllMocks();});
it("persists identity before starting and finishes exactly the acknowledged audio",async()=>{
 await act(async()=>root.render(<Harness/>));
 await act(async()=>api.begin("aliyun",source));
 expect(events[0]).toBe("persist:"+items[0]!.id);expect(events[1]).toBe("start:"+items[0]!.id);
 await act(async()=>api.poll());
 expect(items[0]!.text).toBe("最终文字");expect(items[0]!.state).toBe("completed");
 expect(invoke).toHaveBeenCalledWith("cloud_agents",{action:{op:"voice",request:{action:"finish",job:items[0]!.id,bytes:2}}});
});
it("distinguishes an unavailable cloud from missing service keys and can recheck without starting a job",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;let offline=true;
 vi.mocked(invoke).mockImplementation((command,args:any)=>args?.action?.request?.action==="providers"&&offline?Promise.reject(new Error("暂时无法连接个人云端。")):original(command,args));
 await act(async()=>root.render(<Harness/>));expect(api.connectionState).toBe("offline");expect(api.connectionError).toBe("暂时无法连接个人云端。");
 expect(api.providers).toEqual([]);expect(events).toEqual([]);
 offline=false;await act(async()=>api.recheck());expect(api.connectionState).toBe("ready");expect(api.providers.every(p=>p.configured)).toBe(true);expect(events).toEqual([]);
});
it("reports an absent cloud connection without claiming either provider is unconfigured",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((command,args:any)=>args?.action?.op==="config"?Promise.resolve(null):original(command,args));
 await act(async()=>root.render(<Harness/>));expect(api.connectionState).toBe("missing");expect(api.providers).toEqual([]);expect(events).toEqual([]);
});
it("creation failure keeps the same identity for explicit retry",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;let first=true;
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>{if(args?.action?.request?.action==="start"&&first){first=false;throw new Error("连接中断");}return original(command,args);});
 await act(async()=>root.render(<Harness/>));await act(async()=>api.begin("openai",source));
 const id=items[0]!.id;expect(items[0]!.error).toContain("核对");
 await act(async()=>api.retry(items[0]!));
 expect(items).toHaveLength(1);expect(items[0]!.id).toBe(id);expect(items[0]!.state).toBe("completed");
});
it("restored sessions never upload to a replacement VPS connection",async()=>{
 const old:Transcript={id:crypto.randomUUID(),recordId:"record",provider:"aliyun",source,binding:"old-vps",state:"running",offset:0,text:"先前文字"};
 await act(async()=>root.render(<Harness initial={[old]}/>));
 await expect(api.retry(old)).rejects.toThrow("切回");
 expect(events).toEqual([]);expect(items[0]!.text).toBe("先前文字");
});
it("completed text can be corrected and an applied transcript cannot be added twice",async()=>{
 const apply=vi.fn(),change=vi.fn(),value:Transcript={id:crypto.randomUUID(),recordId:"record",provider:"aliyun",source,binding:"original",state:"completed",text:"原识别文字",offset:0,edited:"校对后的文字",applied:true};
 await act(async()=>root.render(<JournalTranscript value={value} onApply={apply} onChange={change} onRetry={vi.fn()} onCancel={vi.fn()}/>));
 expect(host.querySelector("textarea")!.value).toBe("校对后的文字");expect(host.querySelector("textarea")!.readOnly).toBe(true);
 expect(host.querySelector("button")!.disabled).toBe(true);await act(async()=>host.querySelector("button")!.click());expect(apply).not.toHaveBeenCalled();
});
it("a late creation response cannot put the previous recording into the next draft",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;let release!:(value:Transcript)=>void;
 vi.mocked(invoke).mockImplementation((command,args:any)=>args?.action?.request?.action==="start"?new Promise(resolve=>{release=resolve;}):original(command,args));
 await act(async()=>root.render(<Harness/>));
 let pending!:Promise<void>;
 await act(async()=>{pending=api.begin("aliyun",source);});
 const previous=items[0]!;
 await act(async()=>{reset([]);root.render(<Harness recordId="next-record"/>);});
 await act(async()=>{release({...previous,state:"running",text:"上一条的迟到结果"});await pending;});
 expect(items).toEqual([]);expect(events.filter(e=>e.startsWith("persist:"))).toHaveLength(1);
});


it("stops before a pending network request completes, preserving partial text",async()=>{
 const original=vi.mocked(invoke).getMockImplementation()!;
 let releaseRead!: (value:Transcript)=>void,releaseCancel!: (value:Transcript)=>void;
 vi.mocked(invoke).mockImplementation((command,args:any)=>{
  if(args?.action?.request?.action==="read")return new Promise(resolve=>{releaseRead=resolve;});
  if(args?.action?.request?.action==="cancel")return new Promise(resolve=>{releaseCancel=resolve;});
  return original(command,args);
 });
 await act(async()=>root.render(<Harness/>));
 await act(async()=>api.begin("aliyun",source));
 await act(async()=>reset([{...items[0]!,text:"已识别"}]));
 let polling!:Promise<void>,cancelling!:Promise<void>;
 await act(async()=>{polling=api.poll();});
 await act(async()=>{cancelling=api.cancel(items[0]!);});
 expect(items[0]).toMatchObject({state:"cancelled",text:"已识别",cancelPending:true});
 await act(async()=>{releaseRead({...remote,state:"running",text:"迟到文字"});await polling;});
 expect(items[0]).toMatchObject({state:"cancelled",text:"已识别"});
 expect(events.some(e=>e.startsWith("append:"))).toBe(false);
 await act(async()=>{releaseCancel({...remote,state:"cancelled"});await cancelling;});
 expect(items[0]).toMatchObject({state:"cancelled",text:"已识别",cancelPending:false});
});

it("does not send a saved file to a cloud that advertises only realtime support",async()=>{
 await act(async()=>root.render(<Harness/>));
 await expect(api.begin("aliyun","a".repeat(64),true)).rejects.toThrow("尚未启用");
 expect(events).toEqual([]);
});
