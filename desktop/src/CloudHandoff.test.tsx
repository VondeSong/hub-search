// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {AgentCloudHandoff,CloudHandoffPanel,type CloudHandoff} from "./CloudHandoff";
import {runtimeCapabilities} from "./RuntimePlatform";
const {invoke,save}=vi.hoisted(()=>({invoke:vi.fn(),save:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save}));
const files=[{name:"report.md",type:"md",bytes:80,sha256:"a".repeat(64)},{name:"detail.csv",type:"csv",bytes:20,sha256:"b".repeat(64)},{name:"unselected.json",type:"json",bytes:30,sha256:"c".repeat(64)}];
const item={executionId:"analysis-one",title:"两版比较",revision:2,available:true,runtime:"python",files};
const manifest={version:1 as const,title:item.title,origin:{workId:"work-one",artifactId:"artifact-one",executionId:item.executionId,revision:2,generatedAt:"2026-11-18T01:00:00Z",inputs:[{title:"original.xlsx",sha256:"d".repeat(64)}]},files:files.slice(0,2),report:{name:"report.md",text:"# 已有分析\n新增 7 项，工程判断待核对。",sha256:files[0].sha256}};
const handoff:CloudHandoff={id:"handoff-one",thread:"handoff-one",state:"published",createdAt:1000,publishedAt:2000,manifest};
let host:HTMLDivElement,root:Root;
const click=async(label:string)=>{const b=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===label)!;expect(b).toBeDefined();await act(async()=>b.click());};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();runtimeCapabilities.mobile=false;host=document.createElement("div");document.body.append(host);root=createRoot(host);save.mockReset();invoke.mockReset().mockImplementation(async(_,{action})=>{const request=action.request;if(request.op==="preview")return {manifest,manifestSha256:"fingerprint",id:handoff.id,endpoint:"https://personal.example"};if(request.op==="send")return {handoff};if(request.mode==="status")return {state:"notDownloaded"};if(request.mode==="download")return {state:"downloaded"};if(request.mode==="export")return {state:"saveDialogOpened"};throw Error("Unexpected operation");});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
const render=async(workId="work-one")=>{await act(async()=>root.render(<AgentCloudHandoff workId={workId} item={item}/>));};
it("previews only selected files and requires an explicit send bound to that content and endpoint",async()=>{
 await render();await click("手机继续查看");const checkboxes=[...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];const checkbox=checkboxes[checkboxes.length-1]!;await act(async()=>checkbox.click());await click("预览交接内容");
 expect(invoke.mock.calls).toHaveLength(1);expect(invoke.mock.calls[0][1].action.request.files).toEqual(["report.md","detail.csv"]);
 expect(document.body.textContent).toContain("https://personal.example");expect(document.body.textContent).toContain("不会删除已导出");
 await click("确认发送到个人云端");expect(invoke.mock.lastCall?.[1].action.request).toMatchObject({op:"send",confirm:true,expectedSha256:"fingerprint",expectedId:handoff.id,expectedEndpoint:"https://personal.example",files:["report.md","detail.csv"]});expect(document.body.textContent).toContain("已交接并核对全部文件");
});
it("keeps the same selection and identity after an unknown network result",async()=>{
 await render();await click("手机继续查看");await click("预览交接内容");invoke.mockRejectedValueOnce(Error("连接中断，结果未确认"));await click("确认发送到个人云端");expect(document.body.textContent).not.toContain("已交接并核对全部文件");const first=invoke.mock.lastCall?.[1].action.request;await click("确认发送到个人云端");expect(invoke.mock.lastCall?.[1].action.request).toEqual(first);
});
it("cannot send a selected detail without a report or after changing conversations",async()=>{
 await render();await click("手机继续查看");await act(async()=>document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());const preview=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="预览交接内容")!;expect(preview.disabled).toBe(true);expect(invoke).not.toHaveBeenCalled();await render("work-two");expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("hides the export action for expired revisions",async()=>{
 await act(async()=>root.render(<AgentCloudHandoff workId="work-one" item={{...item,superseded:true}}/>));expect(host.querySelector("button")?.disabled).toBe(true);expect(invoke).not.toHaveBeenCalled();
});
it("keeps desktop analysis separate and downloads only after an explicit action",async()=>{
 await act(async()=>root.render(<CloudHandoffPanel handoff={handoff}/>));expect(host.textContent).toContain("桌面已有分析");expect(host.textContent).toContain("工程判断待核对");expect(invoke.mock.calls.every(([,a])=>a.action.request.mode==="status")).toBe(true);expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter(b=>b.textContent==="保存副本").every(b=>b.disabled)).toBe(true);await click("取回到本机");expect(invoke.mock.lastCall?.[1].action.request).toMatchObject({mode:"download",sha256:files[0].sha256});expect(host.textContent).toContain("已取回并校验");
});
it("does not confuse an open Android save dialog with a verified file",async()=>{
 runtimeCapabilities.mobile=true;await act(async()=>root.render(<CloudHandoffPanel handoff={handoff}/>));await click("取回到本机");await click("保存副本");expect(save).not.toHaveBeenCalled();expect(host.textContent).toContain("尚未确认保存完成");expect(host.textContent).not.toContain("已保存，并回读");invoke.mockImplementation(async()=>({state:"verified"}));await act(async()=>window.dispatchEvent(new Event("focus")));expect(host.textContent).toContain("已保存，并回读核对内容一致");
});
it("does not export when a desktop save destination is cancelled",async()=>{
 await act(async()=>root.render(<CloudHandoffPanel handoff={handoff}/>));await click("取回到本机");const count=invoke.mock.calls.length;save.mockResolvedValue(null);await click("保存副本");expect(invoke.mock.calls.length).toBe(count);expect(host.textContent).not.toContain("已保存，并回读");
});
it("withdrawn snapshots show no report or download buttons",async()=>{
 await act(async()=>root.render(<CloudHandoffPanel handoff={{...handoff,state:"withdrawn",manifest:{...manifest,report:null}}}/>));expect(host.textContent).toContain("云端交接已撤回");expect(host.textContent).not.toContain("新增 7 项");expect(host.querySelector("button")).toBeNull();expect(invoke).not.toHaveBeenCalled();
});
it("renders report tables as scrollable semantic tables instead of pipe text",async()=>{
 const report={...manifest.report,text:"| 变化 | 数量 |\n|---|---:|\n| 新增 | 7 |\n| 删除 | 0 |"};
 await act(async()=>root.render(<CloudHandoffPanel handoff={{...handoff,manifest:{...manifest,report}}}/>));
 const region=host.querySelector<HTMLElement>('[role="region"][aria-label="表格，可横向滚动"]');
 expect(region?.tabIndex).toBe(0);expect(region?.querySelectorAll('thead th')).toHaveLength(2);
 expect([...region!.querySelectorAll('tbody td')].map(cell=>cell.textContent)).toEqual(["新增","7","删除","0"]);
});
