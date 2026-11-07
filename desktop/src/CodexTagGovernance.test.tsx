// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexTagGovernance } from "./CodexTagGovernance";
import { resetCodexSuiteForTests, type CodexSettings } from "./CodexSuite";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const changed = vi.fn();
let settings: CodexSettings; let notices: string[];
const notice = (event: Event) => notices.push((event as CustomEvent).detail.text);
const audit = { status: "active", stale: false, catalogReviewed: 100, catalogTotal: 240, tagsAnalyzed: 2, pairsAnalyzed: 1, candidatePending: 3 };
beforeEach(() => {
  localStorage.clear(); resetCodexSuiteForTests(); settings = { model: "", reasoningEffort: "", fast: false, maxConcurrent: 2 }; notices = []; window.addEventListener("hub:operation-status", notice); changed.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockImplementation(async (command, { args }) => {
    if (command === "model_runtime") return { settings, jobs: [], revision: 1 };
    if (args.action === "definition_models") return { models: [] };
    if (args.action === "governance_audit_status") return { run: audit };
    if (args.action === "governance_analyze") return { analyzed: 1, submitted: [{ proposalId: "p", tags: ["alpha"], preview: { reviewBlocked: true } }], errors: [], coverage: "仅核对所选候选", audit: { ...audit, candidatePending: 2 } };
    throw new Error("Unexpected mutation");
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexSuiteForTests(); window.removeEventListener("hub:operation-status", notice); invoke.mockReset(); });
const click = async (label: string) => { const b = Array.from(host.querySelectorAll("button")).find(b => b.textContent === label)!; expect(b).toBeTruthy(); await act(async () => b.click()); };
it("resumes global analysis and presents blockers without accepting", async () => {
  await act(async () => root.render(<CodexTagGovernance onCompleted={changed} />));
  expect(host.textContent).toContain("100 / 240");
  await click("继续全局检查");
  expect(invoke).toHaveBeenCalledWith("tag_assignment", { args: { action: "governance_analyze", global: true, restart: false, tag: undefined, model: "", reasoningEffort: "", fast: false } });
  expect(host.textContent).toContain("本次已保存 1 项分析记录");
  expect(host.textContent).toContain("暂不能批准");
  expect(changed).toHaveBeenCalledTimes(1);
});
it("uses shared suite model effort and Fast for per-tag analysis", async () => {
  settings = { model: "gpt-test", reasoningEffort: "high", fast: true, maxConcurrent: 2 };
  await act(async () => root.render(<CodexTagGovernance tagId="alpha" onCompleted={changed} />));
  await click("用模型 分析标签关系");
  expect(invoke).toHaveBeenCalledWith("tag_assignment", { args: { action: "governance_analyze", global: false, restart: false, tag: "alpha", model: "gpt-test", reasoningEffort: "high", fast: true } });
});
it("keeps failed runs retryable and ignores results after switching tags", async () => {
  const base = invoke.getMockImplementation()!;
  let finish: (v: unknown) => void = () => {};
  invoke.mockImplementation((command, payload) => payload.args.action === "governance_analyze" ? new Promise(resolve => { finish = resolve; }) : base(command, payload));
  await act(async () => root.render(<CodexTagGovernance tagId="alpha" onCompleted={changed} />));
  await click("用模型 分析标签关系");
  expect(host.textContent).toContain("模型正在分析");
  await act(async () => root.render(<CodexTagGovernance tagId="beta" onCompleted={changed} />));
  await act(async () => finish({ submitted: [{ proposalId: "old" }], errors: [], coverage: "old" }));
  expect(changed).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("本次已保存");
  invoke.mockImplementation((command, payload) => payload.args.action === "governance_analyze" ? Promise.reject("暂时离线") : base(command, payload));
  await click("用模型 分析标签关系");
  expect(notices.join("；")).toContain("暂时离线");
  expect(host.textContent).not.toContain("暂时离线");
});
it("refreshes stale progress after a rejected continuation and offers a fresh check", async () => {
  let stale = false;
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (payload.args.action === "governance_audit_status") return { run: { ...audit, stale } };
    if (payload.args.action === "governance_analyze" && !stale) {
      stale = true;
      throw new Error("索引已经变化，旧审计仅可查看；请创建新审计并重新取证");
    }
    return base(command, payload);
  });
  await act(async () => root.render(<CodexTagGovernance onCompleted={changed} />));
  await click("继续全局检查");
  expect(notices.join("；")).toContain("检查期间数据发生变化，旧记录已保留");
  expect(changed).not.toHaveBeenCalled();
  await click("按最新数据重新检查");
  expect(host.textContent).toContain("本次已保存 1 项分析记录");
  expect(changed).toHaveBeenCalledTimes(1);
});
