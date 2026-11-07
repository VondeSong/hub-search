// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AgentGoalRevision } from "./AgentGoalRevision";
import { AgentGoalAssessment } from "./AgentGoalAssessment";

it.runIf(Boolean(import.meta.env.VITE_HUB_GOAL_REVISION_VIEW_JSON))("shows current interpretation, pending revision, ambiguity and real supersession provenance", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const views = JSON.parse(import.meta.env.VITE_HUB_GOAL_REVISION_VIEW_JSON);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentGoalRevision value={views.initial.goalRevision} />));
    expect(host.textContent).toContain("2024–2026");
    expect(host.textContent).toContain("待澄清");
    await act(async () => root.render(<AgentGoalAssessment value={views.initial.goalAssessment} />));
    expect(host.textContent).not.toContain("目标已完成");
    await act(async () => root.render(<AgentGoalRevision value={views.stale.goalRevision} />));
    expect(host.textContent).toContain("当前解释待修订");
    await act(async () => root.render(<AgentGoalRevision value={views.revised.goalRevision} />));
    expect(host.textContent).toContain("仅统计 2025");
    expect(host.textContent).not.toContain("待澄清");
    expect(host.textContent).toContain("保留图表");
    const details=host.querySelector("details")!;
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("保存前让我看");
    expect(details.textContent).toContain("第 1 版");
    expect(host.textContent).toContain("原始要求和实际授权继续有效");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
