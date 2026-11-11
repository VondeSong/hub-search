// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTagReferences, type TagPreparation } from "./AgentTagWorkspace";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./TagAssignmentInbox",()=>({TagAssignmentInbox:()=>null}));
vi.mock("./TagGovernanceInbox",()=>({TagGovernanceInbox:()=>null}));
let host:HTMLDivElement,root:Root;
const first={tagId:"a",label:"原标签"},second={tagId:"b",label:"比较标签"};
beforeEach(()=>{vi.useFakeTimers();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockImplementation(async(_,{args})=>args.action==="agentTags"?{tags:[second],nextCursor:null}:{definition:null});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it("swaps a selected comparison with the target using Enter without executing a task",async()=>{
  let state:TagPreparation={task:"relations",tag:first,compare:second,references:[],resume:false};
  function Host(){const [value,setValue]=useState(state);state=value;return <AgentTagReferences value={value} mode disabled={false} onChange={setValue} searchOpen={false} onSearchClose={()=>{}}/>;}
  await act(async()=>root.render(<Host/>));
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-tag-token button")!.click());
  await act(async()=>vi.advanceTimersByTimeAsync(250));
  await act(async()=>host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
  expect(state.tag).toEqual(second);expect(state.compare).toEqual(first);
  expect(invoke.mock.calls.every(([,p])=>["agentTags","definition"].includes(p.args.action))).toBe(true);
});
it("replaces an ordinary tag reference while retaining other discussion tags",async()=>{
  let state:TagPreparation={task:"definition",references:[first,{tagId:"c",label:"保留"}],resume:false};
  function Host(){const [value,setValue]=useState(state);state=value;return <AgentTagReferences value={value} mode={false} disabled={false} onChange={setValue} searchOpen={false} onSearchClose={()=>{}}/>;}
  await act(async()=>root.render(<Host/>));
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-tag-token button")!.click());
  await act(async()=>vi.advanceTimersByTimeAsync(250));
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-tag-picker>div button")!.click());
  expect(state.references.map(t=>t.tagId)).toEqual(["c","b"]);expect(state.active).toBeUndefined();
});
