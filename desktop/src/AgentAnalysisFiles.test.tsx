// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentAnalysisFiles,type FileAnalysis} from "./AgentAnalysisFiles";
const {invoke,save}=vi.hoisted(()=>({invoke:vi.fn(),save:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save}));
const file={name:"summary.csv",type:"csv",bytes:20,sha256:"a".repeat(64)};
const item:FileAnalysis={executionId:"analysis-one",title:"核对报告",revision:1,available:true,runtime:"python",files:[file]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();save.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=()=>host.querySelector<HTMLButtonElement>('button[aria-label="导出 summary.csv"]')!;
async function render(value=item,workId="work-one"){await act(async()=>root.render(<AgentAnalysisFiles workId={workId} items={[value]}/>));}
it("does not export or claim success after the user cancels the destination dialog",async()=>{
 save.mockResolvedValue(null);await render();await act(async()=>button().click());
 expect(invoke).not.toHaveBeenCalled();expect(host.textContent).not.toContain("已导出并核对");
});
it("binds export to the selected version and content and only confirms after read-back succeeds",async()=>{
 save.mockResolvedValue("D:/Reports/summary.csv");invoke.mockRejectedValueOnce(new Error("目标已有不同内容"));await render();await act(async()=>button().click());
 expect(host.textContent).toContain("目标已有不同内容");expect(host.textContent).not.toContain("已导出并核对");
 invoke.mockResolvedValue({state:"verified"});await act(async()=>button().click());
 expect(invoke).toHaveBeenLastCalledWith("agent_investigation",{args:{action:"analysisExportFile",id:"work-one",executionId:"analysis-one",file:"summary.csv",expectedSha256:file.sha256,destination:"D:/Reports/summary.csv"}});
 expect(host.textContent).toContain("已导出并核对");
});
it("blocks invalidated files and ignores a pending export when the conversation changes",async()=>{
 await render({...item,available:false});expect(button().disabled).toBe(true);
 let resolve!:(path:string)=>void;save.mockImplementation(()=>new Promise<string>(r=>{resolve=r;}));await render();await act(async()=>button().click());await render(item,"work-two");
 await act(async()=>resolve("D:/Reports/summary.csv"));expect(invoke).not.toHaveBeenCalled();
});
