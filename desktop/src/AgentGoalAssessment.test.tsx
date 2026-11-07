// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AgentGoalAssessment } from "./AgentGoalAssessment";

it.runIf(Boolean(import.meta.env.VITE_HUB_COMPLETION_VIEW_JSON))("shows the persisted goal assessment separately from run settlement", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const views = JSON.parse(import.meta.env.VITE_HUB_COMPLETION_VIEW_JSON);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    expect(views.partial.work.state).toBe("completed");
    await act(async () => root.render(<AgentGoalAssessment value={views.partial.goalAssessment} />));
    expect(host.textContent).toContain("目标待核对");
    expect(host.textContent).toContain("尚未提供逐项完成核对");
    await act(async () => root.render(<AgentGoalAssessment value={views.fulfilled.goalAssessment} />));
    expect(host.textContent).toContain("目标已完成");
    expect(host.querySelector("details")?.open).toBe(false);
    await act(async () => host.querySelector("summary")!.click());
    expect(host.querySelector("details")?.open).toBe(true);
    expect(host.textContent).toContain("模型逐项评估");
    await act(async () => root.render(<AgentGoalAssessment value={views.changed.goalAssessment} />));
    expect(host.textContent).toContain("目标尚未全部完成");
    expect(host.textContent).not.toContain("目标已完成");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each([
  ["notProvided", "partial", true, "已回答"],
  ["notProvided", "partial", false, "目标待核对"],
  ["modelRequirementReview", "partial", true, "目标尚未全部完成"],
  ["modelRequirementReview", "fulfilled", true, "目标已完成"],
  ["notProvided", "blocked", true, "目标受阻"],
  ["notProvided", "cancelled", true, "目标已取消"],
  [undefined, "partial", true, "目标尚未全部完成"],
] as const)("distinguishes review evidence %s / %s / answered=%s", async (source, fulfillment, answered, label) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host=document.createElement("div"), root=createRoot(host);
  const value={workFulfillment:fulfillment,semanticStatusSource:source,completionEvidence:[{requirementId:"r1",criterion:"整理日程",status:"unfulfilled",explanation:"尚未提供逐项完成核对"}]};
  try {
    await act(async()=>root.render(<AgentGoalAssessment value={value} answered={answered}/>));
    expect(host.querySelector("p strong")?.textContent).toBe(label);
    expect(host.querySelector("li strong")?.textContent).toBe(`${source==="notProvided" && fulfillment==="partial" ? "待核对" : "未完成"}：整理日程`);
    expect(value.workFulfillment).toBe(fulfillment);
    expect(host.querySelector("details")?.open).toBe(false);
  } finally {await act(async()=>root.unmount());}
});
