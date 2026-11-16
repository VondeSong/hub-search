// @vitest-environment jsdom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {JournalTranscript,useJournalTranscription,type Transcript} from "./JournalTranscription";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let root:Root,host:HTMLDivElement,api:ReturnType<typeof useJournalTranscription>,items:Transcript[],remote:Transcript,events:string[],connection="original";
const source="a".repeat(32);
function Harness({initial=[]}:{initial?:Transcript[]}){
 const [sessions,setSessions]=useState(initial);items=sessions;
 api=useJournalTranscription({ready:true,recordId:"record",sessions,onChange:async v=>{events.push("persist:"+v.id);setSessions(old=>old.some(s=>s.id===v.id)?old.map(s=>s.id===v.id?v:s):[...old,v]);}});
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
 await act(async()=>api.flush());
 expect(items[0]!.text).toBe("最终文字");expect(items[0]!.state).toBe("completed");
 expect(invoke).toHaveBeenCalledWith("cloud_agents",{action:{op:"voice",request:{action:"finish",job:items[0]!.id,bytes:2}}});
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
