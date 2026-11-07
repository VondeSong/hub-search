// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagGovernanceInbox } from "./TagGovernanceInbox";
import { resetCodexSuiteForTests } from "./CodexSuite";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, payload: any) => {
  if (command === "model_runtime") {
    if (payload?.args?.action === "get" || payload?.args?.action === "status") {
      return Promise.resolve({ settings: { model: "Pagination fixture", reasoningEffort: "low", fast: false, maxConcurrent: 2 }, jobs: [], revision: 1 });
    }
    throw new Error(`Unexpected suite action: ${payload?.args?.action}`);
  }
  if (command === "tag_assignment" && payload?.args?.action === "definition_models") return Promise.resolve({ models: [] });
  if (command === "tag_assignment" && payload?.args?.action === "governance_audit_status") return Promise.resolve({ run: null });
  return invoke(command, payload);
} }));
let container: HTMLDivElement;
let root: Root;
const proposal = (id: string, status = "pending") => ({ proposalId: id, indexRevision: "index", status, summary: id, proposal: { recommendations: [] }, createdAt: 1, updatedAt: 1 });
const health = { status: "healthy", summary: { relationCount: 0, criticalCount: 0, warningCount: 0 }, issues: [] };
const repair = (id: string) => ({ repairRunId: id, proposalIds: [], removedRelationCount: 0, createdAt: 1, change: { criticalCountBefore: 1, criticalCountAfter: 0, warningCountBefore: 0, warningCountAfter: 0 } });
const button = (label: string) => {
  const result = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(result, label).toBeDefined();
  return result!;
};
const click = async (label: string) => { await act(async () => button(label).click()); };
beforeEach(() => {
  resetCodexSuiteForTests();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  invoke.mockReset();
  resetCodexSuiteForTests();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("governance history pagination", () => {
  it("appends pages, deduplicates IDs, keeps totals and stops at the last page", async () => {
    invoke.mockImplementation(async (_command, args) => args.cursor === "c2"
      ? { proposals: [proposal("p3")], total: 3, nextCursor: null }
      : args.cursor === "c1"
        ? { proposals: [proposal("p1"), proposal("p2")], total: 3, nextCursor: "c2" }
        : { proposals: [proposal("p1")], total: 3, nextCursor: "c1" });
    await act(async () => root.render(<TagGovernanceInbox tagId="alpha" />));
    expect(container.querySelector(".codex-suite-summary")?.textContent).toContain("Pagination fixture");
    expect(container.textContent).toContain("已显示 1 / 3 条");
    await click("加载更多建议");
    expect(container.querySelectorAll(".tag-governance-summary")).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith("list_tag_governance_proposals", { tag: "alpha", status: "pending", limit: 50, cursor: "c1" });
    await click("加载更多建议");
    expect(container.textContent).toContain("已显示 3 / 3 条");
    expect(container.textContent).not.toContain("加载更多建议");
  });

  it("preserves rows and the cursor on failure, allowing retry", async () => {
    let fail = true;
    invoke.mockImplementation(async (_command, args) => {
      if (!args.cursor) return { proposals: [proposal("p1")], total: 2, nextCursor: "c1" };
      if (fail) throw new Error("网络中断");
      return { proposals: [proposal("p2")], total: 2, nextCursor: null };
    });
    await act(async () => root.render(<TagGovernanceInbox tagId="alpha" />));
    await click("加载更多建议");
    expect(container.textContent).toContain("加载更多失败，可重试");
    expect(container.querySelectorAll(".tag-governance-summary")).toHaveLength(1);
    expect(button("加载更多建议").disabled).toBe(false);
    fail = false;
    await click("加载更多建议");
    expect(container.textContent).toContain("已显示 2 / 2 条");
    expect(container.textContent).not.toContain("加载更多失败");
  });

  it("isolates status cursors and paginates repair history", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "get_tag_taxonomy_health") return health;
      if (command === "list_tag_taxonomy_repairs") return args.cursor
        ? { repairs: [repair("r2")], total: 2, nextCursor: null }
        : { repairs: [repair("r1")], total: 2, nextCursor: "repairs-next" };
      return args.cursor
        ? { proposals: [proposal(`${args.status}-2`, args.status)], total: 2, nextCursor: null }
        : { proposals: [proposal(`${args.status}-1`, args.status)], total: 2, nextCursor: `${args.status}-next` };
    });
    await act(async () => root.render(<TagGovernanceInbox />));
    expect(container.querySelector(".tag-governance-status-filter")?.textContent).toContain("已批准2");
    await click("已批准2");
    await click("加载更多建议");
    expect(invoke).toHaveBeenCalledWith("list_tag_governance_proposals", { tag: null, status: "accepted", limit: 200, cursor: "accepted-next" });
    await click("待审核2");
    expect(container.textContent).toContain("已显示 1 / 2 条");
    await click("加载更多修复记录");
    expect(invoke).toHaveBeenCalledWith("list_tag_taxonomy_repairs", { limit: 20, cursor: "repairs-next" });
    expect(container.textContent).toContain("已显示 2 / 2 次");
    expect(container.textContent).not.toContain("加载更多修复记录");
  });

  it("ignores a previous tag's late page after switching scope", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((_command, args) => args.cursor
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ proposals: [proposal(args.tag)], total: 2, nextCursor: "next" }));
    await act(async () => root.render(<TagGovernanceInbox tagId="alpha" />));
    await click("加载更多建议");
    expect(button("正在加载…").disabled).toBe(true);
    await act(async () => root.render(<TagGovernanceInbox tagId="beta" />));
    await act(async () => finish({ proposals: [proposal("old-alpha")], total: 2, nextCursor: null }));
    expect(container.querySelector(".tag-governance-summary")?.textContent).toContain("beta");
    expect(container.textContent).not.toContain("old-alpha");
    expect(button("加载更多建议").disabled).toBe(false);
  });

  it("ignores an old page after refresh and reloads the first page", async () => {
    let finish!: (value: unknown) => void;
    let firstLoads = 0;
    invoke.mockImplementation((_command, args) => args.cursor
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ proposals: [proposal(`first-${++firstLoads}`)], total: 2, nextCursor: "next" }));
    await act(async () => root.render(<TagGovernanceInbox tagId="alpha" />));
    await click("加载更多建议");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => finish({ proposals: [proposal("old-page")], total: 2, nextCursor: null }));
    expect(container.textContent).toContain("first-2");
    expect(container.textContent).not.toContain("old-page");
    expect(button("加载更多建议").disabled).toBe(false);
  });
});
