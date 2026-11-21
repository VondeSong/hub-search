// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {AgentAnswerSave,type AnswerSave} from "./AgentAnswerSave";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const changed=vi.fn();
const preview:AnswerSave={saveId:"save",runId:"historical-run",title:"edited title",text:"edited body",mode:"note",targetName:"笔记库",state:"prepared",confirmationToken:"bound-token"};
it("returns focus to More for the answer that opened the dialog",async()=>{
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" disabled={false} records={[]} onChanged={changed}/>));
 const opener=button("更多");
 await openSave("新建笔记");
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="关闭保存回答"]')!.click());
 expect(document.activeElement).toBe(opener);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='submitAnswerSave')).toBe(false);
});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();changed.mockReset();invoke.mockImplementation(async(_,{args})=>args.action==="answerSaveSource"?{title:"original title",text:"original answer",sourceHash:"verified-hash"}:args.action==="answerDestinations"?{libraries:[{id:"notes",name:"笔记库",provider:"obsidian"}]}:args.action==="prepareAnswerSave"?preview:{...preview,state:"verified",receipt:{verified:true,path:"vault/note.md"}});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...document.body.querySelectorAll("button")].find(b=>b.textContent===text)!;
async function openSave(label:string) {
 const opener=button("更多");
 await act(async()=>opener.click());
 await act(async()=>host.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`)!.click());
}
async function field(label:string,value:string){const element=document.body.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true}));});}
it("saves the specifically selected historical answer only after an editable preview and explicit confirmation",async()=>{
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" disabled={false} onChanged={changed}/>));
 await openSave("新建笔记");
 await field("保存资料库","notes");await field("保存标题","edited title");await field("保存正文","edited body");
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="prepareAnswerSave"||v.args.action==="submitAnswerSave")).toBe(false);
 await act(async()=>button("预览保存").click());
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="prepareAnswerSave")![1].args).toMatchObject({id:"work",runId:"historical-run",text:"edited body",sourceHash:"verified-hash",libraryId:"notes",mode:"note"});
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="submitAnswerSave")).toBe(false);
 await act(async()=>button("返回编辑").click());
 expect(document.body.querySelector<HTMLTextAreaElement>('[aria-label="保存正文"]')!.value).toBe("edited body");
 await field("保存资料库","notes");
 await act(async()=>button("预览保存").click());
 await act(async()=>button("确认保存").click());
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="submitAnswerSave")![1].args).toEqual({action:"submitAnswerSave",id:"work",saveId:"save",confirmationToken:"bound-token"});
 expect(document.body.textContent).toContain("已保存并核验");expect(button("确认保存")).toBeUndefined();
});
it.each(["新建笔记","插入页面","创建任务"])("uses the report heading as a separate title only for a new note (%s)",async action=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>payload.args.action==="answerSaveSource"?{title:"long original request",text:"# 待查清单\n\n仍待确认，正文不能丢。",sourceHash:"verified-hash"}:original(command,payload));
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" disabled={false} onChanged={changed}/>));
 await openSave(action);
 expect(document.querySelector<HTMLInputElement>('[aria-label="保存标题"]')!.value).toBe(action==="新建笔记"?"待查清单":"long original request");
 expect(document.querySelector<HTMLTextAreaElement>('[aria-label="保存正文"]')!.value).toBe(action==="新建笔记"?"仍待确认，正文不能丢。":"# 待查清单\n\n仍待确认，正文不能丢。");
 if(action==="新建笔记"){
  await field("保存资料库","notes");await act(async()=>button("预览保存").click());
  expect(invoke.mock.calls.find(([,p])=>p.args.action==="prepareAnswerSave")![1].args).toMatchObject({title:"待查清单",text:"仍待确认，正文不能丢。",sourceHash:"verified-hash"});
 }
 expect(invoke.mock.calls.some(([,p])=>p.args.action==="submitAnswerSave")).toBe(false);
});
it("does not prepare or write when the original answer source is no longer valid",async()=>{
 invoke.mockImplementation(async(_,{args})=>{if(args.action==="answerSaveSource")throw Error("来源授权已撤回");return {libraries:[]};});
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="old" disabled={false} onChanged={changed}/>));
 await openSave("新建笔记");
 expect(document.body.textContent).toContain("来源授权已撤回");expect(button("预览保存").disabled).toBe(true);
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="submitAnswerSave"||v.args.action==="prepareAnswerSave")).toBe(false);
});
it("keeps a searched insertion target when returning from preview instead of switching to the current page",async()=>{
 const original=invoke.getMockImplementation()!;
 const current={kind:"note" as const,libraryId:"notes",documentId:"current",pageId:null};
 const chosen={kind:"note" as const,libraryId:"notes",documentId:"chosen",pageId:null};
 invoke.mockImplementation(async(command,payload)=>{
  const args=payload.args;
  if(args.action==="materials")return {notes:[{locator:chosen,title:"目标笔记",path:"chosen.md",libraryName:"笔记库"}],total:1,nextOffset:null,snapshot:"target-fixture"};
  if(args.action==="prepareAnswerSave")return {...preview,mode:"append",libraryId:"notes",target:args.target,targetTitle:"目标笔记",targetPath:"chosen.md"};
  return original(command,payload);
 });
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" current={current} disabled={false} onChanged={changed}/>));
 await openSave("插入页面");
 await act(async()=>button("当前页面 · 笔记库").click());
 await act(async()=>document.body.querySelector<HTMLInputElement>(".agent-material-choice input")!.click());
 await act(async()=>button("预览保存").click());
 await act(async()=>button("返回编辑").click());
 await act(async()=>button("预览保存").click());
 const requests=invoke.mock.calls.filter(([,p])=>p.args.action==="prepareAnswerSave");
 expect(requests).toHaveLength(2);
 expect(requests[1][1].args.target).toEqual(chosen);
});
it("restores the selected Dida project after editing a task preview",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>{
  const args=payload.args;
  if(args.action==="answerDestinations")return {libraries:[{id:"dida",name:"滴答",provider:"dida365"}]};
  if(args.action==="answerSaveTarget")return {projects:[{id:"first",name:"清单一"},{id:"chosen",name:"目标清单"}]};
  if(args.action==="prepareAnswerSave")return {...preview,mode:"task",libraryId:"dida",projectId:args.projectId,projectName:"目标清单"};
  return original(command,payload);
 });
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" disabled={false} onChanged={changed}/>));
 await openSave("创建任务");
 await field("保存资料库","dida");
 await field("目标滴答清单","chosen");
 await act(async()=>button("预览保存").click());
 expect(document.body.textContent).toContain("目标清单");
 await act(async()=>button("返回编辑").click());
 expect(document.body.querySelector<HTMLSelectElement>('[aria-label="目标滴答清单"]')!.value).toBe("chosen");
});
it("reopens a persisted insertion preview with its recorded page instead of the currently browsed page",async()=>{
 const current={kind:"note" as const,libraryId:"notes",documentId:"current",pageId:null};
 const target={...current,documentId:"recorded-target"};
 const saved={...preview,mode:"append" as const,libraryId:"notes",target,targetTitle:"原目标页面"};
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" current={current} records={[saved]} disabled={false} onChanged={changed}/>));
 await act(async()=>button("查看保存预览").click());
 await act(async()=>button("返回编辑").click());
 await act(async()=>button("预览保存").click());
 expect(invoke.mock.calls.find(([,p])=>p.args.action==="prepareAnswerSave")![1].args.target).toEqual(target);
});
it("asks for a target again for a legacy preview without a locator and never defaults it to the current page",async()=>{
 const current={kind:"note" as const,libraryId:"notes",documentId:"current",pageId:null};
 const saved={...preview,mode:"append" as const,libraryId:"notes"};
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" current={current} records={[saved]} disabled={false} onChanged={changed}/>));
 await act(async()=>button("查看保存预览").click());
 await act(async()=>button("返回编辑").click());
 expect(button("搜索并选择目标页面")).toBeDefined();
 expect(button("预览保存").disabled).toBe(true);
 expect(invoke.mock.calls.some(([,p])=>p.args.action==="prepareAnswerSave")).toBe(false);
});
it("rechecks an already verified save by reading its receipt without submitting another write",async()=>{
 const saved={...preview,state:"verified",receipt:{verified:true,objectId:"actual-task"}};
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" records={[saved]} disabled={false} onChanged={changed}/>));
 await act(async()=>button("查看保存结果").click());
 expect(invoke.mock.calls.find(([,p])=>p.args.action==="inspectAnswerSave")![1].args).toEqual({action:"inspectAnswerSave",id:"work",saveId:"save"});
 expect(invoke.mock.calls.some(([,p])=>p.args.action==="submitAnswerSave"||p.args.action==="prepareAnswerSave")).toBe(false);
});
