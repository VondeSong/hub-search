// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InlineMemoryProposals, MemoryAndSavePopover, MemoryManager } from "./SharedMemory";
import { loadMemoryPreference, rememberMemoryPreference } from "./AgentPreferences";
import { useSharedMemory, type MemoryEntry } from "./useSharedMemory";

const { invoke }=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
const empty={configured:true,entries:[],proposals:[],projects:[{id:"p1",name:"Hub"},{id:"p2",name:"另一项目"}],selection:{projectId:"",enabled:false}};
const proposal={id:"proposal-1",projectId:"p1",expectedVersion:3,candidate:{topicKey:"format",title:"报告格式",body:"报告用中文",kind:"decision" as const,reason:"供后续使用"},source:{origin:"modelProposal",workId:"work-1",sourceRecordId:"message-1",runId:"run-1"}};
let host: HTMLDivElement,root:Root;
const calls=()=>invoke.mock.calls.map(([,argument])=>argument.args);
const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.getAttribute("aria-label")===label||b.textContent?.trim()===label)!;
const click=async(label:string)=>{await act(async()=>button(label).click());};
function Assistant({workId,materialsOnly=false,active=false,canAuto=false,centered=false,onSave=async()=>{}}: {workId?:string;materialsOnly?:boolean;active?:boolean;canAuto?:boolean;centered?:boolean;onSave?:(value:{autoFlashcardInbox:boolean})=>Promise<void>}) {
  const [selection,setSelection]=useState(loadMemoryPreference);
  const model=useSharedMemory({workId,active,blocked:active,selection,onSelectionChange:setSelection});
  return <>
    <button type="button" onClick={event=>model.openManager(event.currentTarget)}>打开管理记忆</button>
    <MemoryAndSavePopover model={model} value={{model:null,autoFlashcardInbox:false}} disabled={active} canAuto={canAuto} materialsOnly={materialsOnly} onSave={onSave}/>
    <InlineMemoryProposals model={model} items={model.proposals}/>
    <output>{JSON.stringify(selection)}</output>
    {model.managerOpen&&<MemoryManager model={model} materialsOnly={materialsOnly} centered={centered}/>}
  </>;
}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  localStorage.clear();
  invoke.mockReset().mockImplementation(async (_, {args})=>args.action==="workProposals"?{proposals:[]}:empty);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function openSettings() {
  const menu=host.querySelector<HTMLDetailsElement>(".agent-memory-disclosure")!;
  await act(async()=>{menu.open=true;menu.dispatchEvent(new Event("toggle"));});
  return menu;
}
async function change(select:HTMLSelectElement,value:string) {
  await act(async()=>{select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));});
}
const turnScope=()=>host.querySelector<HTMLSelectElement>('[aria-label="本对话的记忆范围"]')!;
const enabled=()=>host.querySelector<HTMLInputElement>('[role="switch"]')!;

it("requires separate confirmation for flashcard auto-import and preserves the memory choice",async()=>{
  const save=vi.fn(async()=>{});
  rememberMemoryPreference({projectId:"p1",enabled:true});
  await act(async()=>root.render(<Assistant canAuto onSave={save}/>));
  await openSettings();
  const choice=[...host.querySelectorAll<HTMLButtonElement>(".agent-memory-saving button")].find(item=>item.textContent?.includes("自动导入闪卡收件箱"))!;
  await act(async()=>choice.click());
  expect(save).not.toHaveBeenCalled();
  await click("确认本对话的自动导入授权");
  expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:true});
  expect(loadMemoryPreference()).toEqual({projectId:"p1",enabled:true});
});

it("returns focus to the shield when closing settings and never submits on Escape",async()=>{
  await act(async()=>root.render(<Assistant/>));
  const menu=await openSettings();
  await click("关闭记忆与保存");
  expect(menu.open).toBe(false);expect(document.activeElement).toBe(menu.querySelector("summary"));
  await openSettings();
  await act(async()=>document.activeElement?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true})));
  expect(menu.open).toBe(true);
  await act(async()=>document.activeElement?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(menu.open).toBe(false);expect(document.activeElement).toBe(menu.querySelector("summary"));
  expect(calls().every(args=>args.action==="status")).toBe(true);
});

it("loads memory and save controls without initializing the runtime or changing the draft choice",async()=>{
  rememberMemoryPreference({projectId:"p1",enabled:true});
  await act(async()=>root.render(<Assistant/>));
  await openSettings();
  expect(calls()).toEqual([{action:"status",workId:undefined,prepareRuntime:false}]);
  expect(turnScope().value).toBe("p1");expect(enabled().checked).toBe(true);
  await change(turnScope(),"p2");
  await act(async()=>enabled().click());
  expect(loadMemoryPreference()).toEqual({projectId:"p2",enabled:false});
  expect(calls()).toHaveLength(1);
  expect(host.querySelector(".agent-memory-saving")?.textContent).toContain("保存前确认");
});
it("keeps existing works separate from the last explicit preference until selection succeeds",async()=>{
  rememberMemoryPreference({projectId:"p2",enabled:true});
  invoke.mockImplementation(async (_, {args})=>args.action==="workProposals"?{proposals:[]}:
    {...empty,selection:args.action==="selectScope"?{projectId:args.projectId,enabled:args.enabled}:{projectId:"p1",enabled:false}});
  await act(async()=>root.render(<Assistant workId="work-1"/>));
  await openSettings();
  expect(turnScope().value).toBe("p1");expect(enabled().checked).toBe(false);
  expect(loadMemoryPreference()).toEqual({projectId:"p2",enabled:true});
  await act(async()=>enabled().click());
  expect(calls().slice(-1)[0]).toMatchObject({action:"selectScope",workId:"work-1",projectId:"p1",enabled:true,prepareRuntime:false});
  expect(loadMemoryPreference()).toEqual({projectId:"p1",enabled:true});
});

it("browses another project without changing the current scope or preference",async()=>{
  rememberMemoryPreference({projectId:"p1",enabled:true});
  invoke.mockImplementation(async (_, {args})=>({...empty,proposals:args.projectId==="p2"?[{...proposal,projectId:"p2"}]:[]}));
  await act(async()=>root.render(<Assistant/>));
  await click("打开管理记忆");
  await change(host.querySelector(".agent-memory-manager select")!,"p2");
  await act(async()=>host.querySelectorAll<HTMLButtonElement>(".agent-memory-tabs button")[1].click());
  expect(host.querySelector(".agent-memory-manager-footer")?.textContent).toContain("Hub＋个人通用");
  expect(host.querySelector(".agent-memory-manager [aria-label='建议记住']")?.textContent).toContain("另一项目");
  expect(calls().every(args=>args.action==="status"&&args.prepareRuntime===false)).toBe(true);
  expect(loadMemoryPreference()).toEqual({projectId:"p1",enabled:true});
});

it("shows saved memory cards directly and opens version and source details independently",async()=>{
  const entry:MemoryEntry={id:"m1",projectId:"",topicKey:"format",title:"报告格式",body:"报告用中文。只列经过核对的数据。",kind:"rule",
    version:2,state:"active",source:{origin:"modelProposal",workId:"work-1",sourceRecordId:"message-1"},history:[{version:2},{version:1}]};
  invoke.mockImplementation(async(_, {args})=>args.action==="history"?{versions:[entry,{...entry,version:1,body:"报告用中文。列出采集的数据。"}]}:{...empty,entries:[entry]});
  await act(async()=>root.render(<Assistant centered/>));
  await click("打开管理记忆");
  const card=host.querySelector<HTMLElement>("article.agent-memory-entry")!;
  expect(card.querySelector(".agent-memory-content")?.textContent).toBe(entry.body);
  expect(card.querySelector(".agent-memory-version-badge")?.textContent).toBe("第 2 版");
  expect(calls().some(args=>args.action==="history")).toBe(false);
  const source=card.querySelector<HTMLDetailsElement>(".agent-memory-origin")!;
  const history=card.querySelector<HTMLDetailsElement>(".agent-memory-history")!;
  await act(async()=>{history.open=true;history.dispatchEvent(new Event("toggle"));});
  expect(history.querySelector('[data-version-side="before"] p')?.textContent).toBe("列出采集的数据。");
  expect(history.querySelector('[data-version-side="after"] p')?.textContent).toBe("只列经过核对的数据。");
  expect(history.querySelector(".agent-memory-versions-full")?.textContent).toContain("报告用中文。");
  expect(source.open).toBe(false);
  await act(async()=>source.querySelector("summary")!.click());
  expect(source.open).toBe(true);
  expect(source.textContent).toContain("message-1");
  expect(history.open).toBe(true);
  await click("遗忘");
  expect(calls().some(args=>args.action==="forget")).toBe(false);
  await click("取消");
  expect(card.querySelector(".agent-memory-content")?.textContent).toBe(entry.body);
});

it("opens the newly created project for browsing without using it in the conversation",async()=>{
  rememberMemoryPreference({projectId:"p1",enabled:false});
  let projects=empty.projects;
  invoke.mockImplementation(async (_, {args})=>{
    if(args.action==="createProject")projects=[...projects,{id:"new-project",name:args.name}];
    return {...empty,projects};
  });
  await act(async()=>root.render(<Assistant/>));
  await click("打开管理记忆");await click("更多");
  const field=host.querySelector<HTMLInputElement>(".agent-memory-tools form input")!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"复查");
    field.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await click("创建项目");
  expect(host.querySelector<HTMLSelectElement>(".agent-memory-manager select")!.value).toBe("new-project");
  expect(calls().some(args=>args.action==="status"&&args.projectId==="new-project")).toBe(true);
  expect(loadMemoryPreference()).toEqual({projectId:"p1",enabled:false});
});

it("locks use for materials-only turns while keeping management accessible",async()=>{
  rememberMemoryPreference({projectId:"p1",enabled:true});
  await act(async()=>root.render(<Assistant materialsOnly/>));
  await openSettings();
  expect(enabled().disabled).toBe(true);expect(turnScope().disabled).toBe(true);
  expect(host.querySelector(".agent-memory-permissions")?.textContent).toContain("本轮不使用记忆");
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-memory-manage-link")!.click());
  expect(host.querySelector("[aria-label='管理记忆']")).not.toBeNull();
  expect(loadMemoryPreference().enabled).toBe(true);
});

it("confirms exactly the displayed proposal scope and version and retries with the same request identity",async()=>{
  let writes=0;
  invoke.mockImplementation(async (_, {args})=>{
    if(args.action==="workProposals")return {proposals:[proposal]};
    if(args.action==="put"&&++writes===1)throw Error("暂时无法写入");
    return empty;
  });
  await act(async()=>root.render(<Assistant workId="work-1"/>));
  expect(host.querySelector("[aria-label='建议记住']")?.textContent).toContain("报告用中文");
  expect(calls().some(args=>args.action==="put")).toBe(false);
  await click("记住");
  await click("记住");
  const saves=calls().filter(args=>args.action==="put");
  expect(saves).toHaveLength(2);
  expect(saves[0]).toMatchObject({action:"put",workId:"work-1",confirmed:true,projectId:"p1",expectedVersion:3,proposalId:"proposal-1",topicKey:"format",body:"报告用中文",prepareRuntime:false});
  expect(saves[0].requestKey).toBe(saves[1].requestKey);
  expect(host.querySelector("[aria-label='建议记住']")).toBeNull();
});
it("cancels editing and ignores a suggestion without writing a memory",async()=>{
  invoke.mockImplementation(async (_, {args})=>args.action==="workProposals"?{proposals:[proposal]}:empty);
  await act(async()=>root.render(<Assistant workId="work-1"/>));
  await click("编辑");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("报告用中文");
  await click("取消");await click("忽略");
  expect(calls().some(args=>args.action==="dismissProposal"&&args.proposalId==="proposal-1")).toBe(true);
  expect(calls().some(args=>args.action==="put")).toBe(false);
});

it("rejects a late scope response for the previous work",async()=>{
  let resolve!: (value:unknown)=>void;
  invoke.mockImplementation(async (_, {args})=>args.action==="workProposals"?{proposals:[]}:
    args.workId==="work-1"?new Promise(value=>{resolve=value;}):empty);
  await act(async()=>root.render(<Assistant workId="work-1"/>));
  await openSettings();
  await act(async()=>root.render(<Assistant workId="work-2"/>));
  await act(async()=>resolve({...empty,selection:{projectId:"p1",enabled:true}}));
  expect(turnScope().value).toBe("");expect(enabled().checked).toBe(false);
});
