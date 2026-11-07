// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AgentLifecycle, lifecycleRequest, acceptLifecycleSnapshot } from "./AgentLifecycle";
import { AgentGoalAssessment } from "./AgentGoalAssessment";

it("blocks recovery for the selected mode without disabling an eligible mode",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let resumed=0;
 const value={schemaVersion:1,controlRevision:1,workRevision:1,activeRunId:null,state:"paused",requiresExplicitResume:true,canResume:true,recoveryMode:"newRun",runsUsed:1,runLimit:null,unresolvedActions:0,reason:"",recordedUsage:{},executionModes:{quick:true,deep:false}};
 try{
  await act(async()=>root.render(<AgentLifecycle value={value} mode="deep" disabled={false} onResume={()=>resumed++} onCancel={()=>{}}/>));
  const resume=()=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent==="恢复并继续")!;
  expect(resume().disabled).toBe(true);await act(async()=>resume().click());expect(resumed).toBe(0);
  await act(async()=>root.render(<AgentLifecycle value={value} mode="quick" disabled={false} onResume={()=>resumed++} onCancel={()=>{}}/>));
  expect(resume().disabled).toBe(false);await act(async()=>resume().click());expect(resumed).toBe(1);
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("shows exhausted execution reason while managed run count has no artificial limit",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const value={schemaVersion:1,controlRevision:21,workRevision:1,activeRunId:null,state:"completed",requiresExplicitResume:false,canResume:false,recoveryMode:"newRunWithRevalidatedContext",runsUsed:21,runLimit:null,unresolvedActions:0,reason:"事项执行额度不可用，已暂停新分析；旧成果与待核对结果仍可查看",recordedUsage:{}};
 try{
  await act(async()=>root.render(<AgentLifecycle value={value} disabled={false} onResume={()=>{throw Error("must not resume")}} onCancel={()=>{}}/>));
  expect(host.textContent).toContain("旧成果与待核对结果仍可查看");
  await act(async()=>root.render(<AgentLifecycle value={{...value,reason:""}} disabled={false} onResume={()=>{}} onCancel={()=>{}}/>));
  expect(host.querySelector('[role="status"]')).toBeNull();
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("does not present missing interrupted-model usage as zero",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<AgentLifecycle value={{schemaVersion:1,controlRevision:1,workRevision:2,activeRunId:null,state:"interrupted",requiresExplicitResume:false,canResume:false,recoveryMode:"newRunWithRevalidatedContext",runsUsed:3,runLimit:20,unresolvedActions:0,reason:"",recordedUsage:{agentSessions:1},usageCompleteness:"incomplete",unmeasuredRunIds:["lost-run"],recordedUsageIsLowerBound:true}} disabled={false} onResume={()=>{throw Error("must not auto resume")}} onCancel={()=>{}}/>));
  expect(host.textContent).toContain("1 轮模型用量未完整返回");expect(host.textContent).toContain("不能视为未消耗");
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("names task stopping clearly and offers only one stop action for a paused task",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");const root=createRoot(host);let cancelled=0;
 const value={schemaVersion:1,controlRevision:1,workRevision:1,activeRunId:null,state:"paused",requiresExplicitResume:false,canResume:true,recoveryMode:"newRun",runsUsed:1,runLimit:null,unresolvedActions:0,reason:"",recordedUsage:{}};
 try{
  await act(async()=>root.render(<AgentLifecycle value={value} disabled={false} onResume={()=>{}} onCancel={()=>cancelled++}/>));
  const buttons=Array.from(host.querySelectorAll("button")).filter(b=>b.textContent==="停止此任务");
  expect(buttons).toHaveLength(1);expect(host.textContent).toContain("保留聊天、成果与已完成的操作");
  await act(async()=>buttons[0].click());expect(cancelled).toBe(1);
  await act(async()=>root.render(<AgentLifecycle value={{...value,state:"cancelled",requiresExplicitResume:true}} disabled={false} onResume={()=>{}} onCancel={()=>cancelled++}/>));
  expect(host.textContent).toContain("任务已停止");expect(host.textContent).not.toContain("停止此任务");expect(host.textContent).toContain("恢复并继续");
 }finally{await act(async()=>root.unmount());}
});

it.runIf(Boolean(import.meta.env.VITE_HUB_LIFECYCLE_VIEW_JSON))("renders durable cancellation and explicit recovery from real store snapshots", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const views=JSON.parse(import.meta.env.VITE_HUB_LIFECYCLE_VIEW_JSON);
  expect(acceptLifecycleSnapshot(views.recovered,views.cancelled)).toBe(views.recovered);
  expect(acceptLifecycleSnapshot(views.appended,views.cancelled)).toBe(views.appended);
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  let request: unknown;
  try {
    const value=views.cancelled.lifecycle;
    await act(async()=>root.render(<><AgentLifecycle value={value} disabled={false} onResume={()=>{request=lifecycleRequest(value,"resume-click");}} onCancel={()=>{throw new Error("already cancelled");}}/><AgentGoalAssessment value={views.cancelled.goalAssessment}/></>));
    expect(host.textContent).toContain("任务已停止");
    expect(host.textContent).toContain("待核验动作不会自动重做");
    const button=Array.from(host.querySelectorAll("button")).find(b=>b.textContent==="恢复并继续")!;
    await act(async()=>button.click());
    expect(request).toEqual({commandId:"resume-click",expectedControlRevision:value.controlRevision,expectedWorkRevision:value.workRevision,expectedRunId:null});
    await act(async()=>root.render(<AgentLifecycle value={views.appended.lifecycle} disabled={false} onResume={()=>{}} onCancel={()=>{}}/>));
    expect(host.textContent).toContain("任务已停止");
    expect(host.textContent).toContain("恢复并继续");
    await act(async()=>root.render(<><AgentLifecycle value={views.recovered.lifecycle} disabled={true} onResume={()=>{}} onCancel={()=>{}}/><AgentGoalAssessment value={views.recovered.goalAssessment}/></>));
    expect(host.textContent).not.toContain("恢复并继续");
    expect(host.textContent).not.toContain("目标已完成");
    expect(host.textContent).toContain("目标尚未全部完成");
  } finally {await act(async()=>root.unmount());host.remove();}
});
