// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentSourceScope} from "./AgentSourceScope";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;const confirm=vi.fn();
const page={snapshot:"source-manifest-v1:one",members:[{locator:{kind:"note",libraryId:"notes",documentId:"a",pageId:null},title:"A",path:"daily/a.md"}],totalMembers:40,nextCursor:"source-manifest-v1:one:20",dateCoverage:{unknownDateMembers:1,excludedByDateSelection:1}};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockResolvedValue(page);confirm.mockReset().mockResolvedValue(undefined);});afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!;
async function render(){await act(async()=>root.render(<AgentSourceScope libraryId="notes" disabled={false} canConfirm onConfirm={confirm}/>));}
it("previews metadata and requires explicit whole-manifest confirmation without starting a model",async()=>{
 await render();expect(invoke).not.toHaveBeenCalled();await act(async()=>button("预览材料范围").click());expect(confirm).not.toHaveBeenCalled();expect(button("确认范围并建立对话（不启动分析）").disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());await act(async()=>button("确认范围并建立对话（不启动分析）").click());
 expect(confirm).toHaveBeenCalledExactlyOnceWith({libraryId:"notes",directory:""},page.snapshot);expect(invoke.mock.calls.every(([,p])=>p.args.action==="previewSourceScope")).toBe(true);expect(host.textContent).toContain("正文尚未读取");
});
it("clears consent on paging and discards a changed manifest instead of combining pages",async()=>{
 await render();await act(async()=>button("预览材料范围").click());await act(async()=>host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());invoke.mockResolvedValueOnce({...page,snapshot:"changed"});await act(async()=>button("下一页范围").click());
 expect(host.querySelector('[type="checkbox"]')).toBeNull();expect(host.querySelector('[role="alert"]')?.textContent).toContain("范围已变化");expect(confirm).not.toHaveBeenCalled();expect(invoke).toHaveBeenLastCalledWith("agent_investigation",{args:{action:"previewSourceScope",selection:{libraryId:"notes",directory:""},cursor:page.nextCursor}});
});
