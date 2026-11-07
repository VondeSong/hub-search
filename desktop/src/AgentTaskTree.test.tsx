// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AgentTaskTree } from "./AgentTaskTree";

it.runIf(Boolean(import.meta.env.VITE_HUB_TASK_TREE_VIEW_JSON))("renders persisted task hierarchy, invalidation and historical review", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const views = JSON.parse(import.meta.env.VITE_HUB_TASK_TREE_VIEW_JSON);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentTaskTree value={views.complete.taskTree} />));
    expect(host.textContent).toContain("已完成：汇总结果");
    expect(host.querySelector("li ul li")?.textContent).toContain("核对统计图");
    expect(host.textContent).toContain("依赖：核对统计图");
    await act(async () => root.render(<AgentTaskTree value={views.stale.taskTree} />));
    expect(host.textContent).toContain("待重新核对：核对统计图");
    expect(host.textContent).toContain("待重新核对：汇总结果");
    expect(host.textContent).toContain("已完成：独立说明");
    expect(host.textContent).toContain("查看上次完成核对");
    const details = host.querySelector("details")!;
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("模型评估");
    await act(async () => root.render(<AgentTaskTree value={views.revalidated.taskTree} />));
    expect(host.textContent).not.toContain("待重新核对");
    expect(host.textContent).toContain("已完成：核对统计图");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
