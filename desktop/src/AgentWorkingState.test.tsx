// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentWorkingState, type WorkingState } from "./AgentWorkingState";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
const scope={workId:"work",currentWorkRevision:7,authorizationVersion:2};
const initial:WorkingState={schemaVersion:1,revision:1,entries:[{entryId:"observation",kind:"observation",value:"模型记录：仍需核对完整覆盖",status:"observed",evidenceRefs:[{recordId:"record",sha256:"a".repeat(64)}]}],pendingTargets:[],unresolvedQuestions:["时间口径是否一致？"]};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(value:WorkingState){await act(async()=>root.render(<AgentWorkingState value={value} scope={scope}/>));}

it("shows versioned model notes with a read-only evidence entry and preserves separate goal ownership",async()=>{
  await render(initial);expect(host.querySelector("summary")?.textContent).toContain("第 1 版");
  expect(host.textContent).toContain("目标和步骤仍以上方记录为准");expect(host.textContent).toContain("模型已记录，引用可核对");
  expect(host.textContent).toContain("模型记录：仍需核对完整覆盖");expect(host.textContent).toContain("时间口径是否一致");
  expect(host.querySelector("button")?.textContent).toBe("查看完整工具记录");
  expect(host.textContent).not.toContain("已验证结论");expect(host.querySelector("form")).toBeNull();
});
it("hides stale text and evidence expansion instead of presenting old notes as valid facts",async()=>{
  await render({...initial,revision:2,entries:[{...initial.entries[0],status:"stale",value:null,invalidReason:"来源版本已变化",evidenceRefs:[]}],unresolvedQuestions:[],questionsNeedReview:true});
  expect(host.textContent).toContain("依据已失效");expect(host.textContent).toContain("来源版本已变化");
  expect(host.textContent).not.toContain("模型记录：仍需核对完整覆盖");expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain("旧问题须重新核对");
});
it("renders only actual associated-action states without adding submit or confirmation controls",async()=>{
  await render({...initial,pendingTargets:[{actionId:"existing",kind:"obsidianEdit",state:"unknown"}]});
  expect(host.textContent).toContain("结果待核对");expect(host.textContent).toContain("记录关联不会提交或确认操作");
  expect(Array.from(host.querySelectorAll("button")).map(b=>b.textContent)).toEqual(["查看完整工具记录"]);
  await render({...initial,pendingTargets:[{actionId:"old",kind:"obsidianEdit",state:"prepared",needsRevalidation:true}]});
  expect(host.textContent).toContain("需重新核对");expect(host.textContent).not.toContain("待确认");
});
it("updates from a new authoritative snapshot and explains unsupported records without hiding old product results",async()=>{
  await render(initial);await render({...initial,revision:3,entries:[{...initial.entries[0],value:"较新工作笔记"}]});
  expect(host.textContent).toContain("第 3 版");expect(host.textContent).toContain("较新工作笔记");expect(host.textContent).not.toContain("模型记录：仍需核对完整覆盖");
  await render({state:"unavailable",reason:"版本不支持",entries:[],pendingTargets:[],unresolvedQuestions:[]});
  expect(host.textContent).toContain("原目标与成果保留");expect(host.textContent).toContain("版本不支持");expect(host.textContent).not.toContain("较新工作笔记");
});
it("does not add an empty work-record section to ordinary legacy tasks",async()=>{
  await render({revision:0,entries:[],pendingTargets:[],unresolvedQuestions:[]});expect(host.childElementCount).toBe(0);
});
