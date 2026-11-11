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
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();changed.mockReset();invoke.mockImplementation(async(_,{args})=>args.action==="answerSaveSource"?{title:"original title",text:"original answer",sourceHash:"verified-hash"}:args.action==="answerDestinations"?{libraries:[{id:"notes",name:"笔记库",provider:"obsidian"}]}:args.action==="prepareAnswerSave"?preview:{...preview,state:"verified",receipt:{verified:true,path:"vault/note.md"}});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...document.body.querySelectorAll("button")].find(b=>b.textContent===text)!;
async function field(label:string,value:string){const element=document.body.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[aria-label="${label}"]`)!;const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true}));});}
it("saves the specifically selected historical answer only after an editable preview and explicit confirmation",async()=>{
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="historical-run" disabled={false} onChanged={changed}/>));
 await act(async()=>button("新建笔记").click());
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
it("does not prepare or write when the original answer source is no longer valid",async()=>{
 invoke.mockImplementation(async(_,{args})=>{if(args.action==="answerSaveSource")throw Error("来源授权已撤回");return {libraries:[]};});
 await act(async()=>root.render(<AgentAnswerSave workId="work" runId="old" disabled={false} onChanged={changed}/>));
 await act(async()=>button("新建笔记").click());
 expect(document.body.textContent).toContain("来源授权已撤回");expect(button("预览保存").disabled).toBe(true);
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="submitAnswerSave"||v.args.action==="prepareAnswerSave")).toBe(false);
});
