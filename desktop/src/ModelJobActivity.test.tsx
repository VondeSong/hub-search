// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModelJobActivity, TagTaskActivity } from "./ModelJobActivity";
import type { CodexJob } from "./CodexSuite";
const { suite, cancel } = vi.hoisted(() => ({ suite: { jobs: [] as CodexJob[] }, cancel: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./CodexSuite", () => ({ useCodexSuite: () => suite, cancelModelJob: cancel, publishCodexNotice: vi.fn() }));

it("keeps actual checkpoints on failure and filters activity to the current tag and workflow", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const job: CodexJob = { id: "one", workflow: "tag-definition", context: "方法", label: "生成定义", state: "failed", error: "版本已变化", model: "", reasoningEffort: "", fast: false, progress: [{ at: 1000, message: "开始读取选定资料" }] };
  suite.jobs = [job, { ...job, id: "other", context: "工具", state: "running", progress: [{ at: 2000, message: "其他标签的步骤" }] }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<TagTaskActivity tag="方法" workflows={["tag-definition"]}/>));
    expect(host.textContent).toContain("未完成");
    expect(host.textContent).toContain("版本已变化");
    expect(host.textContent).not.toContain("其他标签的步骤");
    expect(host.textContent).not.toContain("本轮结束");
    await act(async () => root.render(<TagTaskActivity tag="工具" workflows={["tag-definition"]}/>));
    await act(async () => host.querySelector("button")!.click());
    expect(cancel).toHaveBeenCalledWith("other");
    await act(async () => root.render(<ModelJobActivity job={{ ...job, state: "cancelled" }}/>));
    expect(host.textContent).toContain("已停止");
    expect(host.querySelectorAll("li")).toHaveLength(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
