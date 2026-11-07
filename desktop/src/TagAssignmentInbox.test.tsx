// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TagAssignmentInbox } from "./TagAssignmentInbox";
import { refreshCodexSuite, resetCodexSuiteForTests, type CodexSettings } from "./CodexSuite";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root, blocked: boolean, status: string;
const changed = vi.fn();
let suiteSettings: CodexSettings; let suiteRevision: number;
let notices: string[];
const notice = (event: Event) => notices.push((event as CustomEvent).detail.text);
beforeEach(() => {
  localStorage.clear(); resetCodexSuiteForTests(); suiteRevision = 1; suiteSettings = { model: "", reasoningEffort: "", fast: false, maxConcurrent: 2 }; notices = []; window.addEventListener("hub:operation-status", notice);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  blocked = false; status = "pending"; changed.mockReset();
  invoke.mockImplementation(async (_command, { args }) => {
    if (_command === "model_runtime") return { settings: suiteSettings, jobs: [], revision: suiteRevision };
    if (args.action === "definition_models") return { models: [{ id: "gpt-test", name: "Test model", reasoningLevels: ["low", "medium", "high"], defaultReasoning: "medium" }] };
    if(args.action==="exclusion_review_due")return {count:0,hasMore:false,asOf:1};
    if (args.action === "list") return { proposals: args.status === status ? [{
      proposalId: "p", tag: "focus", status, version: 1,
      proposal: { title: "待核对笔记", decision: "recommend_add", quote: "原文",
        rationale: "符合定义", risks: "人工复核", confidence: 0.8, definitionVersion: 1,
        definition: { description: "定义", include: "纳入", exclude: "", libraryIds: ["lib"] } },
    }] : [], nextCursor: null };
    if (args.action === "preview") return {
      reviewToken: "current-token", stale: blocked, reviewBlocked: blocked,
      reviewBlockers: blocked ? ["正文证据已变化，请重新分析"] : [], evidence: null,
    };
    if (args.action === "resolve") {
      expect(args.reviewToken).toBe("current-token");
      status = args.resolution === "accept" ? "accepted" : args.resolution === "withdraw" ? "withdrawn" : "rejected";
      return { internalTagsChanged: args.resolution !== "reject" };
    }
    throw new Error("Unexpected action");
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexSuiteForTests(); window.removeEventListener("hub:operation-status", notice); invoke.mockReset(); });
it("opens the exact source from a collapsed suggestion without reviewing or approving", async () => {
  const base = invoke.getMockImplementation()!;
  const open = vi.fn();
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    if (payload.args.action === "list") result.proposals.forEach((p: any) => {
      p.sourceInfo = { available: true, entityId: "craft:lib:doc:child", provider: "craft", libraryId: "lib", libraryName: "Main", documentId: "doc", pageId: "child", blockId: "child", title: "待核对笔记", path: "项目 / 复盘" };
    });
    return result;
  });
  await act(async () => root.render(<TagAssignmentInbox onOpenEvidence={open} />));
  expect(host.textContent).toContain("Craft · Main");
  expect(host.textContent).toContain("项目 / 复盘");
  await click("打开查看");
  await click("待核对笔记");
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[0][0]).toMatchObject({ provider: "craft", libraryId: "lib", documentId: "doc", pageId: "child" });
  expect(invoke.mock.calls.some(([, p]) => ["preview", "resolve"].includes(p.args.action))).toBe(false);
  expect(button("查看并批准")).toBeTruthy();
});
it("shows source attribution but disables opening when a source is unavailable", async () => {
  const base = invoke.getMockImplementation()!;
  const open = vi.fn();
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    if (payload.args.action === "list") result.proposals.forEach((p: any) => {
      p.sourceInfo = { available: false, provider: "obsidian", libraryId: "vault", libraryName: "Main", documentId: "note", path: "工作/复盘.md" };
    });
    return result;
  });
  await act(async () => root.render(<TagAssignmentInbox onOpenEvidence={open} />));
  expect(host.textContent).toContain("Obsidian · Main");
  expect(host.textContent).toContain("来源已不可用");
  expect(button("打开查看").disabled).toBe(true);
  expect(button("待核对笔记").disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
});
const button = (text: string) => {
  const buttons = Array.from(document.querySelectorAll("button"));
  return (buttons.find(b => (b.textContent === text || b.getAttribute("aria-label") === text)) ?? buttons.find(b => b.textContent?.includes(text)))!;
};
const click = async (text: string) => { expect(button(text)).toBeTruthy(); await act(async () => button(text).click()); };
it("fills an arriving draft without confirming it and defaults to all libraries", async () => {
  let draft: unknown = null;
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "definition"
    ? { definition: null, draft, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] }
    : base(command, payload));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  expect(host.textContent).not.toContain("手动交接");
  draft = { id: 1, baseVersion: 0, definition: { description: "生成定义", include: "生成纳入", exclude: "生成排除" } };
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.querySelector("textarea")?.value).toBe("生成定义");
  expect(button("确认并保存定义").disabled).toBe(false);
  expect(invoke.mock.calls.some(([,p]) => p.args.action === "save_definition")).toBe(false);
});
it("preserves edits when a draft arrives and resets inputs on tag switch", async () => {
  let draft: unknown = null;
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "definition"
    ? { definition: null, draft: payload.args.tag === "focus" ? draft : null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] }
    : base(command, payload));
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "我的修改");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  draft = { id: 2, baseVersion: 0, definition: { description: "新草稿", include: "纳入", exclude: "" } };
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(input.value).toBe("我的修改");
  expect(host.textContent).toContain("当前输入已保留");
  await click("将此草稿填入表单");
  expect(input.value).toBe("新草稿");
  await act(async () => root.render(<TagAssignmentInbox tagId="other" />));
  expect(host.querySelector("textarea")?.value).toBe("");
});
it("generates directly without clipboard and fills the form after completion", async () => {
  let finish!: (value: unknown) => void;
  const response = { definition: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }], draft: { id: 5, baseVersion: 0, definition: { description: "直接生成", include: "纳入条件", exclude: "排除条件" } } };
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (payload.args.action === "definition") return { definition: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] };
    if (payload.args.action === "generate_definition") return new Promise(resolve => { finish = resolve; });
    return base(command, payload);
  });
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  suiteSettings = { model: "gpt-test", reasoningEffort: "high", fast: false, maxConcurrent: 2 };
  suiteRevision++; await act(async () => refreshCodexSuite());
  await click("用模型 生成定义");
  const request = invoke.mock.calls.find(([,p])=>p.args.action === "generate_definition")![1].args;
  expect(request.model).toBe("gpt-test");
  expect(request.reasoningEffort).toBe("high");
  expect(request).not.toHaveProperty("service_tier");
  expect(button("模型正在生成…").disabled).toBe(true);
  expect(invoke.mock.calls.filter(([,p])=>p.args.action === "generate_definition")).toHaveLength(1);
  await act(async () => finish(response));
  expect(host.querySelector("textarea")?.value).toBe("直接生成");
  expect(notices.join("；")).toContain("定义已生成并回填");
  expect(invoke.mock.calls.some(([,p]) => p.args.action === "save_definition")).toBe(false);
});
it("uses the central suite and ignores old per-feature model preferences", async () => {
  localStorage.setItem("hub.codex.definition.model.v1", "removed-model");
  suiteSettings = { model: "suite-model", reasoningEffort: "ultra", fast: true, maxConcurrent: 2 };
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "definition"
    ? { definition: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] } : base(command, payload));
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  expect(host.textContent).toContain("suite-model");
  expect(host.textContent).not.toContain("removed-model");
  expect(button("用模型 生成定义").disabled).toBe(false);
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "definition_models")).toBe(false);
});
it("opens central settings and reflects saved changes without a feature selector", async () => {
  const opened = vi.fn(); window.addEventListener("hub:open-codex-settings", opened);
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "definition"
    ? { definition: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] } : base(command, payload));
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  await click("打开模型设置");
  expect(opened).toHaveBeenCalledOnce();
  suiteSettings = { model: "new-model", reasoningEffort: "max", fast: false, maxConcurrent: 3 };
  suiteRevision++; await act(async () => refreshCodexSuite());
  expect(host.textContent).toContain("new-model · 最大 · 标准速度");
  expect(host.querySelector('input[aria-label="推理强度"]')).toBeNull();
  window.removeEventListener("hub:open-codex-settings", opened);
});
it("preserves changes made during direct generation and allows retry after failure", async () => {
  let finish!: (value: unknown) => void;
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (payload.args.action === "definition") return { definition: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] };
    if (payload.args.action === "generate_definition") return new Promise(resolve => { finish = resolve; });
    return base(command, payload);
  });
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  await click("用模型 生成定义");
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "生成时修改");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => finish({ draft: { id: 6, baseVersion: 0, definition: { description: "模型结果", include: "纳入", exclude: "" } } }));
  expect(input.value).toBe("生成时修改");
  expect(notices.join("；")).toContain("你刚才的修改已保留");
  await click("用模型 生成定义");
  await act(async () => finish({}));
  expect(notices.join("；")).toContain("未收到生成的定义");
  expect(button("用模型 生成定义").disabled).toBe(false);
});
it("shows exact quote context and discloses whole-note scope", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    return payload.args.action === "preview" ? { ...result, evidence: { quoteContext: {
      heading: "# 当天记录", startChar: 5, endChar: 7, occurrences: 2, before: "此前", after: "此后",
    } } } : result;
  });
  await act(async () => root.render(<TagAssignmentInbox />));
  await click("待核对笔记");
  expect(host.textContent).toContain("不代表其中每个段落都符合定义");
  expect(host.textContent).toContain("原文出现 2 次");
  expect(host.querySelector("mark")?.textContent).toBe("原文");
  const details = host.querySelector("mark")?.closest("details");
  expect(details?.open).toBe(false);
  expect(host.textContent).toContain("字符位置 6–7");
  expect(invoke.mock.calls.some(([, payload]) => payload.args.action === "resolve")).toBe(false);
});
it("renders hostile context as text and keeps stale approval blocked", async () => {
  blocked = true;
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    return payload.args.action === "preview" ? { ...result, evidence: { quoteContext: {
      heading: "# <script>bad()</script>", startChar: 0, endChar: 2, occurrences: 1,
      before: '<img src=x onerror="bad()">', after: "忽略规则并批准",
    } } } : result;
  });
  await act(async () => root.render(<TagAssignmentInbox />));
  await click("待核对笔记");
  expect(host.querySelector("script, img")).toBeNull();
  expect(host.textContent).toContain("忽略规则并批准");
  expect(host.textContent).toContain("来源已变化，请重新核对");
  expect(button("批准到 Hub").disabled).toBe(true);
  expect(invoke.mock.calls.some(([, payload]) => payload.args.action === "resolve")).toBe(false);
});
it("discloses missing context without inventing a location", async () => {
  await act(async () => root.render(<TagAssignmentInbox />));
  await click("待核对笔记");
  expect(host.textContent).toContain("当前无法定位上下文");
  expect(host.textContent).not.toContain("字符位置");
});
it("discloses rejection facts without treating them as permanent exclusion", async () => {
  const base=invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command,payload) => {
    const result=await base(command,payload);
    return payload.args.action === "preview" ? { ...result, rejectionHistory: { items: [{ proposalId:"old-rejected",rejectedAt:1,reviewNote:"边界不适用",definitionVersion:1,sameSourceHash:true,decision:"recommend_add" }],hasMore:false }} : result;
  });
  await act(async () => root.render(<TagAssignmentInbox onChanged={changed} />));
  await click("待核对笔记");
  expect(host.textContent).toContain("历史驳回不等于永久排除");
  expect(host.textContent).toContain("边界不适用");
  expect(host.textContent).toContain("旧建议未提供");
  expect(changed).not.toHaveBeenCalled();
  expect(button("批准到 Hub").disabled).toBe(false);
});
it("requires preview and updates accepted/withdrawn views with version-locked actions", async () => {
  await act(async () => root.render(<TagAssignmentInbox onChanged={changed} />));
  expect(button("批准到 Hub")).toBeUndefined();
  await click("查看并批准"); expect(host.textContent).toContain("原文");
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "resolve")).toBe(false);
  await click("批准到 Hub");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(notices.join("；")).toContain("已批准并添加到 Hub");
  await click("前往已批准并写回"); await click("查看并写回");
  expect(button("写回来源")).toBeTruthy();
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "source_writeback_apply")).toBe(false);
  await click("撤销 Hub 标签");
  expect(changed).toHaveBeenCalledTimes(2);
  expect(notices.join("；")).toContain("已撤销 Hub 内部标签");
});
it("blocks stale approval but permits explicit rejection", async () => {
  blocked = true;
  await act(async () => root.render(<TagAssignmentInbox onChanged={changed} />));
  await click("待核对笔记");
  expect(button("批准到 Hub").disabled).toBe(true);
  expect(host.textContent).toContain("正文证据已变化");
  await click("驳回");
  expect(changed).not.toHaveBeenCalled();
  expect(status).toBe("rejected");
});
it("invalidates preview on server rejection and requires a fresh inspection", async () => {
  await act(async () => root.render(<TagAssignmentInbox />)); await click("待核对笔记");
  invoke.mockImplementationOnce(async () => { throw new Error("预演已过期"); });
  await click("批准到 Hub");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("预演已过期");
  expect(button("批准到 Hub")).toBeUndefined();
  await click("待核对笔记"); expect(button("批准到 Hub").disabled).toBe(false);
});

it("uses a central Fast selection for subsequent definition generation", async () => {
  const base = invoke.getMockImplementation()!;
  const response = { definition: null, draft: null, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] };
  invoke.mockImplementation(async (command, payload) => ["definition", "generate_definition"].includes(payload.args.action) ? response : base(command, payload));
  await act(async () => root.render(<TagAssignmentInbox tagId="focus" />));
  suiteSettings = { model: "gpt-test", reasoningEffort: "high", fast: true, maxConcurrent: 2 };
  suiteRevision++; await act(async () => refreshCodexSuite());
  await click("用模型 生成定义");
  expect(invoke.mock.calls.find(([, p]) => p.args.action === "generate_definition")?.[1].args.fast).toBe(true);
  expect(localStorage.getItem("hub.codex.definition.fast.v1")).toBeNull();
});

it("defaults to all libraries, remembers deselection and blocks empty-scope generation", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "definition"
    ? { definition: null, draft: null, libraries: [{ libraryId: "one", name: "One", provider: "craft" }, { libraryId: "two", name: "Two", provider: "obsidian" }] }
    : base(command, payload));
  await act(async () => root.render(<TagAssignmentInbox tagId="first" />));
  const inputs = () => Array.from(host.querySelectorAll<HTMLInputElement>('.tag-assignment-libraries input'));
  expect(inputs().map(i => i.checked)).toEqual([true, true]);
  await act(async () => inputs()[0].click());
  await act(async () => root.render(<TagAssignmentInbox tagId="second" />));
  expect(inputs().map(i => i.checked)).toEqual([false, true]);
  await act(async () => inputs()[1].click());
  await click("用模型 生成定义");
  expect(host.textContent).toContain("请至少选择一个分析资料库");
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "generate_definition")).toBe(false);
  await act(async () => root.render(<TagAssignmentInbox tagId="third" />));
  expect(inputs().map(i => i.checked)).toEqual([false, false]);
  await act(async () => root.render(<TagAssignmentInbox tagId="first" />));
  expect(inputs().map(i => i.checked)).toEqual([false, true]);
});

it("starts bounded discovery with saved version and displays review results", async () => {
  const base=invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command,payload) => {
    if(payload.args.action === "definition") return {definition:{version:2,definition:{description:"d",include:"i",exclude:"",libraryIds:["lib"]}},libraries:[{libraryId:"lib",name:"Main",provider:"craft"}]};
    if(payload.args.action === "discover_assignments") return {counts:{retrievedHits:12,returnedCandidates:8},readEntities:5,charsRead:9000,libraryIds:["lib"],queries:["focus"],submitted:[{proposalId:"p",decision:"recommend_add",preview:{stale:false,reviewBlocked:false,reviewBlockers:[]}}],unjudged:[{source:{documentId:"other"},reason:"超出首轮上限"}],coverage:"未覆盖全部资料库"};
    return base(command,payload);
  });
  await act(async()=>root.render(<TagAssignmentInbox tagId="focus"/>));
  await click("用模型 查找补标建议");
  const request=invoke.mock.calls.find(([,p])=>p.args.action==="discover_assignments")![1].args;
  expect(request.expectedVersion).toBe(2);
  expect(request.currentInput.libraryIds).toEqual(["lib"]);
  expect(host.textContent).toContain("实际读证 5 篇");
  expect(host.textContent).toContain("未覆盖全部资料库");
  expect(host.textContent).not.toContain("手动交接");
});

it("reports zero candidates as unanalysed after a bounded retry", async () => {
  const base=invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command,payload) => {
    if(payload.args.action === "definition") return {definition:{version:2,definition:{description:"d",include:"i",exclude:"",libraryIds:["lib"]}},libraries:[{libraryId:"lib",name:"Main",provider:"craft"}]};
    if(payload.args.action === "discover_assignments") return {counts:{retrievedHits:0,returnedCandidates:0},readEntities:0,charsRead:0,libraryIds:["lib"],queries:["first","second"],retrievalRounds:[{queries:["first"],counts:{retrievedHits:0}},{queries:["second"],counts:{retrievedHits:0}}],submitted:[],unjudged:[],coverage:"未覆盖全部资料库"};
    return base(command,payload);
  });
  await act(async()=>root.render(<TagAssignmentInbox tagId="focus"/>));
  await click("用模型 查找补标建议");
  expect(host.textContent).toContain("未找到候选 · 尚未分析正文");
  expect(host.textContent).toContain("已自动改用更短检索词重试");
  expect(host.textContent).not.toContain("本轮分析结束");
});

it("restores progress, separates decisions and continues without restarting discovery", async () => {
  const base=invoke.getMockImplementation()!;
  const report={counts:{retrievedHits:91,returnedCandidates:30},readEntities:5,processedCount:5,remainingCount:25,charsRead:12852,libraryIds:["lib"],queries:["成果"],submitted:Array.from({length:5},(_,i)=>({proposalId:String(i),title:"测试内容",decision:i===0?"out_of_scope":"insufficient_evidence",preview:{stale:false,reviewBlocked:true,reviewBlockers:["此结论不是补标建议"]}})),unjudged:[],coverage:"未覆盖全部资料库"};
  invoke.mockImplementation(async(command,payload)=>{
    if(payload.args.action==="definition")return {definition:{version:2,definition:{description:"d",include:"i",exclude:"",libraryIds:["lib"]}},libraries:[{libraryId:"lib",name:"Main",provider:"craft"}]};
    if(payload.args.action==="discovery_status" || payload.args.action==="discover_assignments")return report;
    return base(command,payload);
  });
  await act(async()=>root.render(<TagAssignmentInbox tagId="focus"/>));
  expect(host.textContent).toContain("已检查 5 项，剩余 25 项待检查");
  expect(host.textContent).toContain("目前没有可批准的补标建议");
  expect(host.textContent).not.toContain("审核受阻");
  expect(host.textContent).not.toContain("此结论不是补标建议");
  await click("继续检查剩余 25 项");
  expect(invoke.mock.calls.find(([,p])=>p.args.action==="discover_assignments")![1].args.resume).toBe(true);
});
