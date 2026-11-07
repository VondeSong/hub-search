// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {AgentFollowups,type Followup} from "./AgentFollowups";
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const item:Followup={clientMessageId:"one",editVersion:2,state:"queued",deliveryMode:"queue",payload:{text:"稍后分析",addNotes:[{kind:"note",libraryId:"notes",documentId:"one"}],addImages:[]}};
it.each([[true,false,false],[true,true,true],[false,false,true]])("gates queue promotion by the current run capability (active=%s canSteer=%s)",async(active,canSteer,allowed)=>{
 const action=vi.fn().mockResolvedValue(undefined);
 await act(async()=>root.render(<AgentFollowups items={[item]} busy={false} active={active} canSteer={canSteer} onAction={action} onResume={()=>{}}/>));
 const send=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='立即发送')!;
 expect(send.disabled).toBe(!allowed);
 await act(async()=>send.click());
 expect(action).toHaveBeenCalledTimes(allowed?1:0);
 expect(host.textContent?.includes('当前运行不支持即时追加')).toBe(!allowed);
 expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='编辑')!.disabled).toBe(false);
});
it("edits a queued message without dropping its material or changing another draft",async()=>{
 const action=vi.fn().mockResolvedValue(undefined);await act(async()=>root.render(<AgentFollowups items={[item]} busy={false} canSteer={true} active onAction={action} onResume={()=>{}}/>));
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='编辑')!.click());
 const input=host.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'修订');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='保存待发修改')!.click());
 expect(action).toHaveBeenCalledWith(item,'edit',{text:'修订',addNotes:item.payload.addNotes,addImages:[]});
});
it("keeps unknown delivery visible without offering resend and holds stopped queues",async()=>{
 const resume=vi.fn();await act(async()=>root.render(<AgentFollowups items={[{...item,state:'unconfirmed'},{...item,clientMessageId:'two',state:'held'}]} busy={false} canSteer={true} active={false} onAction={vi.fn()} onResume={resume}/>));
 expect(host.textContent).toContain('投递结果待核对');expect(host.querySelectorAll('li')[0].querySelector('button')).toBeNull();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='继续发送队列')!.click());expect(resume).toHaveBeenCalledOnce();
});
it("preserves edits on conflict and reports the actual error",async()=>{
 await act(async()=>root.render(<AgentFollowups items={[item]} busy={false} canSteer={true} active onAction={vi.fn().mockRejectedValue(new Error('消息已经开始投递'))} onResume={()=>{}}/>));
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='编辑')!.click());
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='保存待发修改')!.click());
 expect(host.querySelector('textarea')?.value).toBe(item.payload.text);expect(host.querySelector('[role="alert"]')?.textContent).toContain('消息已经开始投递');
});
