// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeCapabilities } from "./RuntimePlatform";
import { SearchHeaderActions } from "./SearchHeaderActions";
import { AgentPanelProvider, StandaloneAgentLauncher } from "./StandaloneAgentLauncher";
import { StandaloneInvestigation } from "./AgentInvestigation";
import CloudAgents from "./CloudAgents";
import { outbox } from "./CloudAgentMedia";
import type { CloudHandoff } from "./CloudHandoff";

const { invoke, save } = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./CloudAgentMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./CloudAgentMedia")>();
  return {
    ...actual,
    outbox: vi.fn(async () => undefined),
    uploadSize: () => 0,
    imageUpload: vi.fn(),
    videoUploads: vi.fn(),
  };
});
vi.mock("./CloudAgentDrafts", () => ({
  loadComposerDrafts: vi.fn(async () => new Map()),
  saveComposerDraft: vi.fn(async () => {}),
}));
vi.mock("./CodexSuite", async importOriginal => {
  const actual = await importOriginal<typeof import("./CodexSuite")>();
  return {
    ...actual,
    useCodexSuite: () => ({ loaded: true, settings: { provider: "codex", model: "gpt-5.3-codex", reasoningEffort: "medium" }, accounts: [], refresh: vi.fn() }),
    codexSelectionLabel: (value?: { model?: string }) => value?.model || "Codex",
  };
});
vi.mock("./CodexAccounts", () => ({
  authorizeCodexConversation: vi.fn(async () => {}),
  getCodexAccountSnapshot: () => ({ loaded: true, loading: false, current: { scopeId: "acct-1" } }),
  refreshCodexAccounts: vi.fn(async () => {}),
}));
vi.mock("./CodexAccountsSettings", () => ({
  CodexAccountBadge: () => null,
  CodexAccountContext: () => null,
  CodexAccountDialog: () => null,
}));
vi.mock("./useSharedMemory", () => ({
  useSharedMemory: () => ({
    selection: { enabled: false, projectId: "" },
    busy: false,
    managerOpen: false,
    proposals: [],
    openManager: vi.fn(),
    closeManager: vi.fn(),
    projectLabel: () => "个人通用",
  }),
}));
vi.mock("./SharedMemory", () => ({
  InlineMemoryProposals: () => null,
  MemoryAndSavePopover: () => null,
  MemoryManager: () => null,
  MemoryToolbarButton: () => null,
  wrapDialogTab: () => {},
}));

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
};

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await flush();
}

function findButton(label: string, scope: ParentNode = document.body): HTMLElement {
  const match = [...scope.querySelectorAll<HTMLElement>("button, summary")].find(
    el => el.getAttribute("aria-label") === label || el.textContent?.trim() === label,
  );
  expect(match, `Missing button/summary: ${label}`).toBeTruthy();
  return match!;
}

async function click(label: string, scope: ParentNode = document.body) {
  const el = findButton(label, scope);
  await act(async () => {
    el.focus();
    el.click();
  });
  await flush();
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

function makeWorkView(withFiles = false) {
  return {
    recordVersion: 1,
    conversationTitle: "线束复核工作",
    work: {
      id: "work-1",
      anchor: null,
      goal: "整理线束异常统计",
      revision: 1,
      authorizationVersion: 1,
      state: "completed",
      report: {
        status: "completed",
        summary: "已汇总 5 个月异常统计",
        findings: [],
        nextSteps: [],
        questions: [],
        limitations: [],
        waitCondition: "",
        prose: { markdown: "已汇总 5 个月线束异常与复核记录。", citations: [] },
      },
      grant: { libraryIds: [], notes: [], readingItemKeys: [] },
    },
    evidence: [],
    decisions: [],
    run: { id: "run-1", usage: {} },
    validity: "",
    conversation: {
      hasEarlier: false,
      messages: [
        { id: "m-u1", role: "user", text: "整理线束异常统计", revision: 1, createdAt: 1000 },
        {
          id: "m-a1",
          role: "assistant",
          runId: "run-1",
          revision: 1,
          createdAt: 2000,
          report: {
            status: "completed",
            summary: "已汇总 5 个月异常统计",
            findings: [],
            nextSteps: [],
            questions: [],
            limitations: [],
            waitCondition: "",
            prose: { markdown: "已汇总 5 个月线束异常与复核记录。", citations: [] },
          },
          evidence: [],
        },
      ],
    },
    fileAnalyses: withFiles
      ? [
          {
            executionId: "analysis-1",
            title: "线束台架异常报告",
            revision: 2,
            available: true,
            runtime: "python",
            files: [
              { name: "report.md", type: "md", bytes: 120, sha256: "a".repeat(64) },
              { name: "detail.csv", type: "csv", bytes: 64, sha256: "b".repeat(64) },
            ],
          },
        ]
      : [],
  };
}

const sampleHandoff: CloudHandoff = {
  id: "11111111-1111-1111-1111-111111111111",
  thread: "11111111-1111-1111-1111-111111111111",
  state: "published",
  createdAt: 1000,
  publishedAt: 2000,
  manifest: {
    version: 1,
    title: "线束台架异常报告",
    origin: {
      workId: "work-1",
      artifactId: "artifact-1",
      executionId: "analysis-1",
      revision: 2,
      generatedAt: "2026-11-23T08:00:00Z",
      inputs: [{ title: "台架记录.xlsx", sha256: "c".repeat(64) }],
    },
    files: [
      { name: "report.md", type: "md", bytes: 120, sha256: "a".repeat(64) },
      { name: "detail.csv", type: "csv", bytes: 64, sha256: "b".repeat(64) },
    ],
    report: { name: "report.md", text: "# 线束台架异常报告\n新增 2 项待复核。", sha256: "a".repeat(64) },
  },
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  runtimeCapabilities.desktop = true;
  runtimeCapabilities.mobile = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  invoke.mockReset();
  save.mockReset();
  vi.mocked(outbox).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Phase 3 Agents: cloud history, phone handoff, and multi-window", () => {
  it("keeps a single assistant entry in SearchHeaderActions", async () => {
    const noop = vi.fn();
    await render(
      <AgentPanelProvider>
        <SearchHeaderActions
          showAgent
          activeFilterCount={0}
          filtersOpen={false}
          hasSelectedResult={false}
          isMobileLayout={false}
          mobilePreviewOpen={false}
          searching={false}
          showPreviewPane={false}
          setFiltersOpen={noop}
          setMobilePreviewOpen={noop}
          setPreviewOpen={noop}
        />
      </AgentPanelProvider>,
    );
    expect(document.querySelectorAll('button[aria-label="Hub 助手"]')).toHaveLength(1);
    expect(document.querySelector('button[aria-label="云端助手"]')).toBeNull();
  });

  it("integrates real personal-cloud history into the History drawer, opens embedded cloud chat without losing local draft, and brings a bounded snapshot back to local composer", async () => {
    const mobileThreadId = "22222222-2222-2222-2222-222222222222";
    const now = Date.now();
    vi.mocked(outbox).mockResolvedValue({
      thread: mobileThreadId,
      turn: "pending-turn-1",
      text: "待确认的手机消息",
      attachments: [],
      created: now,
    });
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") {
          return { works: [{ id: "work-1", goal: "本机历史对话", state: "completed", updatedAt: now - 3600_000 }], nextCursor: null };
        }
        return makeWorkView(false);
      }
      if (command === "cloud_agents") {
        const op = payload.action.op;
        if (op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (op === "list") {
          return {
            threads: [{ id: mobileThreadId, title: "外出拍摄：前舱线束复核", updated: now - 60_000, archived: false, preview: "净距偏紧", status: "completed", matches: true }],
            threadManagement: true,
            account: { state: "ready", model: "gpt-5.3-codex", plan: "Pro" },
          };
        }
        if (op === "read" && payload.action.thread === mobileThreadId) {
          return {
            thread: {
              id: mobileThreadId,
              title: "外出拍摄：前舱线束复核",
              updated: now - 60_000,
              before: null,
              turns: [{ id: "t-1", seq: 1, created: now - 60_000, text: "帮我看下支架间隙", answer: "3 号卡扣净距不足 10mm，建议按 V3 前移 12mm。", attachments: [], status: "completed" }],
            },
            account: { state: "ready" },
          };
        }
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    const localInput = document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!;
    await typeInto(localInput, "保留这条尚未发送的本机草稿");

    await click("对话历史");
    expect(document.body.textContent).toContain("全部 (2)");
    expect(document.body.textContent).toContain("个人云端 (1)");
    expect(document.body.textContent).not.toContain("来自手机");
    expect(document.querySelector(`[data-cloud-thread-id="${mobileThreadId}"]`)).not.toBeNull();

    await click("个人云端 (1)");
    expect(document.querySelector('[data-work-id="work-1"]')).toBeNull();
    expect(document.body.textContent).toContain("新建云端对话");
    expect(document.body.textContent).toContain("连接与设备");
    expect(document.body.textContent).toContain("有一条待确认云端消息");

    await click("打开云端对话 外出拍摄：前舱线束复核");
    expect(document.querySelector(".agent-cloud-embed")).not.toBeNull();
    expect(document.body.textContent).toContain("个人云端会话");
    expect(document.body.textContent).not.toContain("来自手机的云端会话");
    expect(document.body.textContent).toContain("3 号卡扣净距不足 10mm");
    expect(document.querySelector<HTMLElement>(".agent-body")?.hidden).toBe(true);

    await click("带入本机继续");
    expect(document.querySelector(".agent-cloud-embed")).toBeNull();
    expect(document.querySelector<HTMLElement>(".agent-body")?.hidden).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("保留这条尚未发送的本机草稿");
    expect(document.querySelector('[aria-label="待添加资料"]')?.textContent).toContain("外出拍摄：前舱线束复核");
    expect(invoke.mock.calls.some(([cmd, p]) => cmd === "agent_investigation" && ["create", "message", "respond"].includes(p?.args?.action))).toBe(false);
  });

  it("shows honest unconfigured cloud state in History and opens personal-cloud settings from Inspector without unsolicited calls", async () => {
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") return { works: [], nextCursor: null };
        if (payload.args.action === "skills") return { skills: [] };
        return makeWorkView(false);
      }
      if (command === "cloud_agents" && payload.action.op === "config") return null;
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await click("对话详情");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "cloud_agents")).toBe(false);
    const cloudDetailButton = document.querySelector<HTMLButtonElement>(".agent-detail-cloud-link")!;
    expect(cloudDetailButton).not.toBeNull();
    expect(cloudDetailButton.textContent).toContain("个人云端与手机");
    expect(cloudDetailButton.textContent).toContain("查看与连接");

    await act(async () => {
      cloudDetailButton.focus();
      cloudDetailButton.click();
    });
    await flush();
    expect(document.querySelector(".agent-cloud-embed")).not.toBeNull();
    expect(document.body.textContent).toContain("连接与设备");
    expect(document.body.textContent).toContain("服务地址");

    await click("返回本机对话");
    expect(document.querySelector(".agent-cloud-embed")).toBeNull();

    await click("对话历史");
    await click("个人云端");
    expect(document.body.textContent).toContain("尚未连接个人云端");
    expect(findButton("连接个人云端")).toBeTruthy();
  });

  it("surfaces real report handoff at the Work-level analysis bar (never misattributed to answer toolbars), shows titled inline receipt, opens cloud thread, and withdraws honestly", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let handoffState: CloudHandoff["state"] = "published";
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") return { works: [{ id: "work-1", goal: "整理线束异常统计", state: "completed" }], nextCursor: null };
        return makeWorkView(true);
      }
      if (command === "cloud_agents") {
        const action = payload.action;
        if (action.op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (action.op === "list") return { threads: [{ id: sampleHandoff.thread, title: sampleHandoff.manifest.title, updated: 2000, archived: false, matches: 1 }], threadManagement: true, account: { state: "ready" } };
        if (action.op === "read") return { thread: { id: sampleHandoff.thread, title: sampleHandoff.manifest.title, updated: 2000, before: null, handoff: { ...sampleHandoff, state: handoffState }, turns: [] }, account: { state: "ready" } };
        if (action.op === "handoff") {
          if (action.request.op === "preview") {
            return { manifest: sampleHandoff.manifest, manifestSha256: "sha-preview", id: sampleHandoff.id, endpoint: "https://agents.example.test" };
          }
          if (action.request.op === "send") return { handoff: sampleHandoff };
          if (action.request.op === "withdraw") {
            handoffState = "withdrawn";
            return { ok: true };
          }
          if (action.request.op === "file" && action.request.mode === "status") return { state: "notDownloaded" };
        }
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen />);
    expect(document.querySelector(".agent-answer-toolbar")?.textContent).not.toContain("发到手机继续");
    const handoffBar = document.querySelector<HTMLElement>(".agent-analysis-handoff-bar")!;
    expect(handoffBar).not.toBeNull();
    expect(handoffBar.textContent).toContain("线束台架异常报告");
    expect(handoffBar.textContent).toContain("第 2 版");
    expect(findButton("发到手机继续", handoffBar)).toBeTruthy();
    await click("发到手机继续", handoffBar);
    await click("预览交接内容");
    await click("确认发送到个人云端");
    expect(document.body.textContent).toContain("已交接并核对全部文件");

    await click("关闭");
    expect(document.querySelector(".hub-handoff-receipt")?.textContent).toContain("「线束台架异常报告」第 2 版已发至个人云端（固定静态副本 · 2 个文件");
    expect(findButton("本版已发手机", handoffBar)).toBeTruthy();
    expect(document.querySelector(".agent-answer-toolbar")?.textContent).not.toContain("已发手机");

    await click("打开云端会话");
    expect(document.querySelector(".agent-cloud-embed")).not.toBeNull();
    expect(document.body.textContent).toContain("桌面交接 · 个人云端会话");
    expect(document.body.textContent).toContain("桌面已有分析");
    expect(document.body.textContent).toContain("取回到本机");
    await click("返回本机对话");

    await click("撤回交接");
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("cloud_agents", { action: { op: "handoff", request: { op: "withdraw", thread: sampleHandoff.id, confirm: true } } });
    expect(document.querySelector(".hub-handoff-receipt.is-withdrawn")?.textContent).toContain("已撤回「线束台架异常报告」第 2 版的云端交接副本");
    expect(findButton("发到手机继续", handoffBar)).toBeTruthy();
  });

  it("syncs withdrawn state from embedded CloudHandoffPanel and live cloud checks without showing stale published status, and offers a post-reload cloud handoff entry", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let remoteState: CloudHandoff["state"] = "published";
    let readCached = false;
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") return { works: [{ id: "work-1", goal: "整理线束异常统计", state: "completed" }], nextCursor: null };
        return makeWorkView(true);
      }
      if (command === "cloud_agents") {
        const action = payload.action;
        if (action.op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (action.op === "list") return { threads: [{ id: sampleHandoff.thread, title: sampleHandoff.manifest.title, updated: 2000, archived: false, matches: 1 }], threadManagement: true, account: { state: "ready" } };
        if (action.op === "read") {
          return {
            cached: readCached,
            thread: { id: sampleHandoff.thread, title: sampleHandoff.manifest.title, updated: 2000, before: null, handoff: { ...sampleHandoff, state: remoteState }, turns: [] },
            account: { state: "ready" },
          };
        }
        if (action.op === "handoff") {
          if (action.request.op === "preview") return { manifest: sampleHandoff.manifest, manifestSha256: "sha-preview", id: sampleHandoff.id, endpoint: "https://agents.example.test" };
          if (action.request.op === "send") return { handoff: sampleHandoff };
          if (action.request.op === "withdraw") {
            remoteState = "withdrawn";
            return { ok: true };
          }
          if (action.request.op === "file" && action.request.mode === "status") return { state: "notDownloaded" };
        }
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    // Post-reload: Work-level handoff bar is visible without expanding <details> and explains the live cloud source.
    await render(<StandaloneInvestigation initiallyOpen />);
    expect(document.querySelector(".hub-handoff-receipt")).toBeNull();
    const handoffBar = document.querySelector<HTMLElement>(".agent-analysis-handoff-bar")!;
    expect(handoffBar).not.toBeNull();
    expect(handoffBar.textContent).toContain("刷新后已发布交接与撤回状态以「个人云端」实时记录为准");
    await click("在个人云端查看已发交接", handoffBar);
    expect(document.querySelector(".agent-cloud-embed")).not.toBeNull();
    expect(document.body.textContent).toContain("你的云端对话");

    // Opening the handoff thread and withdrawing inside embedded CloudHandoffPanel immediately updates local state.
    const embedRoot = document.querySelector<HTMLElement>(".agent-cloud-embed")!;
    const threadButton = [...embedRoot.querySelectorAll<HTMLButtonElement>(".cloud-agents-thread")].find(b => b.textContent?.includes("线束台架异常报告"))!;
    expect(threadButton).toBeTruthy();
    await act(async () => {
      threadButton.focus();
      threadButton.click();
    });
    await flush();
    expect(document.body.textContent).toContain("桌面交接 · 个人云端会话");
    await click("撤回云端交接", embedRoot);
    await click("返回本机对话");
    expect(document.querySelector(".hub-handoff-receipt.is-withdrawn")?.textContent).toContain("已撤回「线束台架异常报告」第 2 版的云端交接副本");
    expect([...document.querySelectorAll("button")].some(b => b.textContent?.includes("已发手机"))).toBe(false);

    // Send a fresh handoff, verify cached warning honesty, then simulate remote withdrawal on phone detected via 核对云端状态.
    remoteState = "published";
    await click("发到手机继续", handoffBar);
    await click("预览交接内容");
    await click("确认发送到个人云端");
    await click("关闭");
    expect(findButton("本版已发手机", handoffBar)).toBeTruthy();

    readCached = true;
    await click("核对云端状态");
    expect(document.querySelector(".hub-handoff-receipt")?.textContent).toContain("当前仅读取到本机缓存");

    readCached = false;
    remoteState = "withdrawn";
    await click("核对云端状态");
    expect(document.querySelector(".hub-handoff-receipt.is-withdrawn")?.textContent).toContain("已撤回「线束台架异常报告」第 2 版的云端交接副本");
    expect([...document.querySelectorAll("button")].some(b => b.textContent?.includes("已发手机"))).toBe(false);
  });

  it("filters numeric 0/1 SQLite matches in unified history search and falls back honestly on missing or stale cached query results", async () => {
    const now = Date.now();
    let failSearch = false;
    let legacyMode = false;
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") {
          const q = String(payload.args.query || "");
          const works = [{ id: "work-t29", goal: "T29主清单切换真实新版后核对", state: "completed", updatedAt: now - 10_000 }];
          return { works: q ? works.filter(w => w.goal.includes(q)) : works, nextCursor: null };
        }
        return makeWorkView(false);
      }
      if (command === "cloud_agents") {
        const op = payload.action.op;
        if (op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (op === "list") {
          const q = String(payload.action.query || "");
          if (failSearch && q) throw new Error("网络断开");
          if (legacyMode) {
            return {
              threads: [
                { id: "c-title", title: "T29主清单切换真实新版后 · 摘要", updated: now - 1000, archived: false, preview: "对比完成" },
                { id: "c-other", title: "今日日期安排", updated: now - 2000, archived: false, preview: "买菜清单" },
              ],
              threadManagement: false,
              account: { state: "ready" },
            };
          }
          // SQLite server.py returns integer 0 / 1 for `matches`
          return {
            threads: [
              { id: "c-body-hit", title: "云端差异复核记录", updated: now - 1000, archived: false, preview: "正文命中", matches: q ? 1 : 1 },
              { id: "c-miss-zero", title: "今日日期", updated: now - 2000, archived: false, preview: "无关对话", matches: q ? 0 : 1 },
              { id: "c-miss-bool", title: "周末采购", updated: now - 3000, archived: false, preview: "无关对话", matches: q ? false : true },
            ],
            threadManagement: true,
            account: { state: "ready" },
          };
        }
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await click("对话历史");
    expect(document.querySelector('[data-cloud-thread-id="c-body-hit"]')).not.toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-miss-zero"]')).not.toBeNull();

    await click("搜索对话标题和提问");
    const searchInput = document.querySelector<HTMLInputElement>('input[aria-label="搜索对话标题和提问"]')!;
    await typeInto(searchInput, "T29主清单切换真实新版后");

    // Numeric matches === 0 and boolean false must be filtered out; matches === 1 body match must remain.
    expect(document.querySelector('[data-work-id="work-t29"]')).not.toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-body-hit"]')).not.toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-miss-zero"]')).toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-miss-bool"]')).toBeNull();

    // When a subsequent search fails offline, stale threads from an earlier query (with matches: 1) must NOT leak unrelated items.
    await typeInto(searchInput, "");
    expect(document.querySelector('[data-cloud-thread-id="c-miss-zero"]')).not.toBeNull();
    failSearch = true;
    await typeInto(searchInput, "T29主清单切换真实新版后");
    expect(document.querySelector('[data-cloud-thread-id="c-miss-zero"]')).toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-miss-bool"]')).toBeNull();

    // Legacy server without threadManagement/matches honestly falls back to title/preview matching.
    failSearch = false;
    legacyMode = true;
    await typeInto(searchInput, "T29主清单");
    expect(document.querySelector('[data-cloud-thread-id="c-title"]')).not.toBeNull();
    expect(document.querySelector('[data-cloud-thread-id="c-other"]')).toBeNull();
  });

  it("never attaches an earlier report receipt to a newer CSV-only turn and lets users pick exact deliverable and revision at Work level", async () => {
    const viewWithMultiDeliverables = {
      ...makeWorkView(false),
      run: { id: "run-3", usage: {} },
      conversation: {
        hasEarlier: false,
        messages: [
          { id: "m-u1", role: "user", text: "生成独立差异报告", revision: 1, createdAt: 1000 },
          { id: "m-a1", role: "assistant", runId: "run-1", revision: 1, createdAt: 2000, report: makeWorkView(false).work.report, evidence: [] },
          { id: "m-u2", role: "user", text: "导出第 3 版 sheet_summary.csv", revision: 2, createdAt: 3000 },
          {
            id: "m-a2",
            role: "assistant",
            runId: "run-3",
            revision: 2,
            createdAt: 4000,
            report: { ...makeWorkView(false).work.report, summary: "已交付第 3 版 sheet_summary.csv", prose: { markdown: "已交付第 3 版 sheet_summary.csv。", citations: [] } },
            evidence: [],
          },
        ],
      },
      fileAnalyses: [
        {
          executionId: "analysis-csv-v3",
          runId: "run-3",
          title: "sheet_summary.csv 汇总",
          revision: 3,
          available: true,
          runtime: "python",
          files: [{ name: "sheet_summary.csv", type: "csv", bytes: 512, sha256: "d".repeat(64) }],
        },
        {
          executionId: "analysis-1",
          runId: "run-1",
          title: "独立差异报告",
          revision: 2,
          available: true,
          runtime: "python",
          files: [
            { name: "report.md", type: "md", bytes: 120, sha256: "a".repeat(64) },
            { name: "detail.csv", type: "csv", bytes: 64, sha256: "b".repeat(64) },
            { name: "chart.png", type: "png", bytes: 256, sha256: "e".repeat(64) },
            { name: "meta.json", type: "json", bytes: 48, sha256: "f".repeat(64) },
          ],
        },
        {
          executionId: "analysis-review-v1",
          runId: "run-2",
          title: "复核总结报告",
          revision: 1,
          available: true,
          runtime: "python",
          files: [{ name: "review.md", type: "md", bytes: 90, sha256: "9".repeat(64) }],
        },
      ],
    };
    const rev2Handoff: CloudHandoff = {
      ...sampleHandoff,
      manifest: { ...sampleHandoff.manifest, title: "独立差异报告", files: viewWithMultiDeliverables.fileAnalyses[1].files },
    };
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") return { works: [{ id: "work-1", goal: "整理线束异常统计", state: "completed" }], nextCursor: null };
        return viewWithMultiDeliverables;
      }
      if (command === "cloud_agents") {
        const action = payload.action;
        if (action.op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (action.op === "list") return { threads: [{ id: rev2Handoff.thread, title: rev2Handoff.manifest.title, updated: 2000, archived: false, matches: 1 }], threadManagement: true, account: { state: "ready" } };
        if (action.op === "read") return { thread: { id: rev2Handoff.thread, title: rev2Handoff.manifest.title, updated: 2000, before: null, handoff: rev2Handoff, turns: [] }, account: { state: "ready" } };
        if (action.op === "handoff" && action.request.op === "file" && action.request.mode === "status") return { state: "notDownloaded" };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen />);
    // Open the real cloud handoff for rev 2 and return to the local work (mirroring real-desktop flow).
    const handoffBar = document.querySelector<HTMLElement>(".agent-analysis-handoff-bar")!;
    await click("在个人云端查看已发交接", handoffBar);
    const embedRoot = document.querySelector<HTMLElement>(".agent-cloud-embed")!;
    const threadButton = [...embedRoot.querySelectorAll<HTMLButtonElement>(".cloud-agents-thread")].find(b => b.textContent?.includes("独立差异报告"))!;
    await act(async () => { threadButton.click(); });
    await flush();
    await click("返回本机对话");

    // Latest rev 3 CSV message toolbar must NOT show any handoff or "已发手机" button!
    for (const toolbar of document.querySelectorAll(".agent-answer-toolbar")) {
      expect(toolbar.textContent).not.toContain("已发手机");
      expect(toolbar.textContent).not.toContain("发到手机继续");
    }

    // Work-level bar explicitly identifies rev 2 as sent, and switches cleanly to "发到手机继续" when choosing unsent rev 1.
    const select = handoffBar.querySelector<HTMLSelectElement>('select[aria-label="选择交接成果"]')!;
    expect(select).not.toBeNull();
    expect(select.value).toBe("analysis-1");
    expect(select.options[0].textContent).toContain("独立差异报告 · 第 2 版（4 个文件 · 本次已发）");
    expect(findButton("本版已发手机", handoffBar)).toBeTruthy();
    expect(document.querySelector(".hub-handoff-receipt")?.textContent).toContain("「独立差异报告」第 2 版已发至个人云端（固定静态副本 · 4 个文件");

    await act(async () => {
      select.value = "analysis-review-v1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(findButton("发到手机继续", handoffBar)).toBeTruthy();
  });

  it("does not show a fake handoff button for plain-text answers without eligible fileAnalyses and returns from embedded cloud view on Escape", async () => {
    const mobileThreadId = "33333333-3333-3333-3333-333333333333";
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation") {
        if (payload.args.action === "list") return { works: [{ id: "work-1", goal: "纯文字对话", state: "completed" }], nextCursor: null };
        return makeWorkView(false);
      }
      if (command === "cloud_agents") {
        if (payload.action.op === "config") return { endpoint: "https://agents.example.test", binding: "device-1" };
        if (payload.action.op === "list") return { threads: [{ id: mobileThreadId, title: "手机端随手问", updated: Date.now(), archived: false, matches: true }], threadManagement: true, account: { state: "ready" } };
        if (payload.action.op === "read") return { thread: { id: mobileThreadId, title: "手机端随手问", updated: Date.now(), before: null, turns: [] }, account: { state: "ready" } };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(<StandaloneInvestigation initiallyOpen />);
    expect([...document.querySelectorAll("button")].some(b => b.textContent?.includes("发到手机继续"))).toBe(false);
    await typeInto(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!, "继续追问草稿");
    await click("对话历史");
    await click("打开云端对话 手机端随手问");
    expect(document.querySelector(".agent-cloud-embed")).not.toBeNull();

    const panel = document.querySelector<HTMLElement>(".agent-panel")!;
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(panel.hidden).toBe(false);
    expect(document.querySelector(".agent-cloud-embed")).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("继续追问草稿");
  });

  it("opens a clean parallel second assistant from the layout menu and Alt+J (without binding WebView2 Ctrl+Shift+J) while preserving both drafts", async () => {
    invoke.mockImplementation(async (command, payload) => {
      if (command === "agent_investigation" && payload.args.action === "list") return { works: [], nextCursor: null };
      return makeWorkView(false);
    });

    await render(
      <AgentPanelProvider>
        <StandaloneAgentLauncher />
      </AgentPanelProvider>,
    );
    await click("Hub 助手");
    const main = document.querySelector<HTMLElement>(".agent-panel:not([data-agent-extra])")!;
    const mainInput = main.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!;
    await typeInto(mainInput, "主助手草稿");

    // Verify Ctrl+Shift+J is NOT intercepted by frontend (WebView2 reserves it for DevTools).
    await act(async () => {
      mainInput.dispatchEvent(new KeyboardEvent("keydown", { key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector(".agent-panel[data-agent-extra]")).toBeNull();

    await click("切换窗口形态", main);
    expect(main.querySelector(".agent-window-menu")?.textContent).toContain("多窗口与并行");
    expect(main.querySelector(".agent-window-menu")?.textContent).toContain("Alt+J");
    expect(main.querySelector(".agent-window-menu")?.textContent).not.toContain("Ctrl+Shift+J");
    expect(main.querySelector(".agent-window-menu")?.textContent).toContain("独立桌面窗口");
    expect(main.querySelector(".agent-window-menu")?.textContent).toContain("Ctrl+Alt+J");
    await click("双开第二个助手", main);

    const second = document.querySelector<HTMLElement>(".agent-panel[data-agent-extra]")!;
    expect(second.hidden).toBe(false);
    expect(second.querySelector(".agent-window-badge")?.textContent).toBe("窗口 2");
    await typeInto(second.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!, "窗口 2 并行草稿");

    await click("关闭第二个助手", second);
    expect(second.hidden).toBe(true);
    expect(main.hidden).toBe(false);
    expect(mainInput.value).toBe("主助手草稿");

    // Verify Alt+J works even when focus is inside the main assistant's composer textarea!
    await act(async () => {
      mainInput.focus();
      mainInput.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(second.hidden).toBe(false);
    expect(second.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("窗口 2 并行草稿");

    // Verify Alt+J is safely ignored while recording a shortcut inside .shortcut-setting-control.
    await click("关闭第二个助手", second);
    expect(second.hidden).toBe(true);
    const recorder = document.createElement("div");
    recorder.className = "shortcut-setting-control";
    const recorderButton = document.createElement("button");
    recorder.append(recorderButton);
    document.body.append(recorder);
    await act(async () => {
      recorderButton.focus();
      recorderButton.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(second.hidden).toBe(true);
    recorder.remove();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(second.hidden).toBe(false);

    await click("关闭助手", main);
    expect(main.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    expect(second.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("窗口 2 并行草稿");

    await click("切换窗口形态", second);
    await click("切换到主助手", second);
    expect(main.hidden).toBe(false);
    expect(main.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("主助手草稿");
  });

  it("preserves Android mobile CloudAgents rendering and disables desktop multi-window shortcut on mobile", async () => {
    runtimeCapabilities.desktop = false;
    runtimeCapabilities.mobile = true;
    invoke.mockImplementation(async (command, payload) => {
      if (command === "cloud_agents") {
        if (payload.action.op === "config") return { endpoint: "https://agents.example.test", binding: "device-m" };
        if (payload.action.op === "list") {
          return { threads: [{ id: "m-1", title: "手机端会话", updated: Date.now(), archived: false, matches: true }], threadManagement: true, account: { state: "ready" } };
        }
        if (payload.action.op === "read") {
          return { thread: { id: "m-1", title: "手机端会话", updated: Date.now(), before: null, turns: [] }, account: { state: "ready" } };
        }
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await render(
      <AgentPanelProvider>
        <CloudAgents onClose={vi.fn()} />
      </AgentPanelProvider>,
    );
    expect(document.querySelector(".cloud-agents.is-mobile")).not.toBeNull();
    expect(document.querySelector(".cloud-agents-context-strip")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.querySelector(".agent-panel[data-agent-extra]")).toBeNull();
  });
});
