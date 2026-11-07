// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {AgentMaterials} from "./AgentMaterials";
import {AgentImages} from "./AgentImages";
import {AgentMcpServices} from "./AgentMcpServices";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
it.each(["materials","images","mcp"])("%s Enter respects Chinese composition before deliberate submission",async kind=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 const changed=vi.fn(),page={notes:[],total:0,nextOffset:null,snapshot:"s",images:[],hasMore:false};
 invoke.mockReset().mockResolvedValue(page);
 let finishInitialImages:(()=>void)|undefined;
 if(kind==="images")invoke.mockImplementationOnce(()=>new Promise(resolve=>{finishInitialImages=()=>resolve(page);}));
 try {
  await act(async()=>root.render(kind==="materials"?<AgentMaterials selected={[]} disabled={false} onChange={changed}/>:kind==="images"?<AgentImages current={[]} disabled={false} onApply={changed}/>:<AgentMcpServices value={[]} disabled={false} onChange={changed}/>));
  const input=host.querySelector<HTMLInputElement>("input")!;
  if(kind==="images"){
   expect(invoke.mock.calls).toEqual([["agent_investigation",{args:{action:"imageMaterials",query:""}}]]);
   expect(input.disabled).toBe(true);
   await act(async()=>finishInitialImages!());
   expect(input.disabled).toBe(false);
  }
  const initialCalls=kind==="images"?1:0;
  expect(invoke).toHaveBeenCalledTimes(initialCalls);
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,kind==="mcp"?"https://docs.example.org/mcp":"中文资料");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true})));
  expect(invoke).toHaveBeenCalledTimes(initialCalls);expect(host.textContent).not.toContain("外部 MCP 服务 · docs.example.org");
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  if(kind==="mcp"){
   expect(host.textContent).toContain("外部 MCP 服务 · docs.example.org");
   expect(invoke).not.toHaveBeenCalled();
  }else{
   expect(invoke).toHaveBeenCalledTimes(initialCalls+1);
   expect(invoke.mock.calls.slice(initialCalls)).toEqual([["agent_investigation",{args:kind==="images"?{action:"imageMaterials",query:"中文资料"}:{action:"materials",query:{query:"中文资料",offset:0,limit:20}}}]]);
  }
  expect(changed).not.toHaveBeenCalled();
 } finally {await act(async()=>root.unmount());host.remove();}
});
