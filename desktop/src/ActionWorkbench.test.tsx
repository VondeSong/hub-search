// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { archiveAction } from "./ActionJournal";
import { groupsFor, emptyMeta, identity, write, read, type ActionMeta } from "./ActionState";
import { extractClues, generate, matchExisting, queryMaterials, type Material } from "./ActionEvidence";
import { ActionHarvester } from "./ActionHarvester";
import { ActionDetail } from "./ActionDetail";
import { Materials, assembleMaterials } from "./ActionMaterials";
import type { SearchResult } from "./SearchTypes";
import { ActionTopic } from "./ActionTopic";
import { TaskWorkspace } from "./ActionWorkspace";
import type { LibrarySummary } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./QuickJournal", () => ({ QuickJournalCard: () => null }));
const profile = vi.hoisted(() => new Map<string, string>());
const flush = vi.hoisted(() => vi.fn(async () => {}));
const dashboard = vi.hoisted(() => ({ tasks: [] as UnifiedTask[] }));
vi.mock("./UnifiedTaskData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./UnifiedTaskData")>()),
  useUnifiedTasks: () => ({
    dashboard,
    refresh: async () => {},
    taskBusyIds: new Set(),
    taskStatusTargets: new Map(),
  }),
}));
vi.mock("./UserProfileStorage", () => ({
  userProfileStorage: {
    getItem: (k: string) => profile.get(k) ?? null,
    setItem: (k: string, v: string) => profile.set(k, v),
    flush: async () => {},
  },
  flushUserProfileStorage: flush,
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label))!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
};
const day = "2026-11-25";
const t = {
  id: "hub",
  provider: "dida365",
  libraryId: "lib",
  libraryName: "工作",
  documentId: "a",
  sourceId: "a",
  documentTitle: "T29",
  collectionId: "project",
  title: "验证管夹改为 120mm 后的安装间距",
  status: "open",
  completed: false,
  isProject: false,
  tags: [],
  sourceRefs: [],
  isAllDay: true,
  contentRevision: "rev",
  syncState: "unlinked",
} as unknown as UnifiedTask;
const journal: QuickJournalItem = {
  libraryId: "notes",
  applied: false,
  uploaded: false,
  path: "",
  namespace: "",
  record: { version: 1, id: "record", date: day, text: "待确认：管夹改为 120mm 后的安装间距", attachments: [] },
  body: "待确认：管夹改为 120mm 后的安装间距",
};
const wait = { id: "one", who: "结构组", what: "支架数模", review: day, blocking: true };
const parallel = { id: "two", who: "供应商", what: "耐温报告", review: "2026-11-28", blocking: false };
beforeEach(() => {
  profile.clear();
  flush.mockReset();
  flush.mockResolvedValue(undefined);
  dashboard.tasks = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_quick_journal") return { items: [], error: "" };
    if (command === "get_quick_journal_settings") return { settings: { libraryId: "notes" } };
    return [];
  });
});

const dida = { id: "lib", name: "滴答清单", provider: "dida365" } as LibrarySummary;
const workbenchAction = (params: unknown) => (params as { args?: { action?: string } } | undefined)?.args?.action;

describe("行动工作台", () => {
  it("滴答已建而本地计划未保存时，保留原请求并使用同一个回执恢复", async () => {
    const ids: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command, params) => {
      if (command === "list_quick_journal") return { items: [], error: "" };
      if (command === "get_quick_journal_settings") return { settings: { libraryId: "notes" } };
      if (workbenchAction(params) === "createTask") {
        ids.push((params as { args: { requestId: string } }).args.requestId);
        dashboard.tasks = [t];
        if (ids.length === 1) flush.mockRejectedValueOnce(new Error("本地保存失败"));
        return { state: "confirmed", task: t };
      }
      return [];
    });
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="新建行动"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, t.title);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("本地保存失败");
    expect(Object.keys(read("quick.requests", {}))).toHaveLength(1);
    await click(button("核对原请求"));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(read("quick.requests", {})).toEqual({});
    expect(host.querySelector('section[aria-label="今日计划（额外自选）"]')?.textContent).toContain(t.title);
  });

  it("今日计划满五项时不再排入，快捷输入仍可采纳到待办", async () => {
    dashboard.tasks = Array.from({ length: 6 }, (_, i) => ({
      ...t,
      id: "hub-" + i,
      sourceId: "source-" + i,
      title: "工程检查 " + i,
    }));
    const today = new Intl.DateTimeFormat("sv-SE").format(new Date());
    for (const task of dashboard.tasks.slice(0, 5)) {
      await write("task." + identity(task), { ...emptyMeta(), day: today });
    }
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    expect(host.textContent).toContain("计划 5/5");
    expect(button("AI 安排今天").disabled).toBe(true);
    expect(host.querySelector('input[aria-label="新建行动"]')?.getAttribute("placeholder")).toBe(
      "随手记一条行动，回车同步滴答…",
    );
  });

  it("同一行动只进一组；按到期、今日计划、未来等待的顺序展示", () => {
    const m = { ...emptyMeta(), day, waits: [wait, parallel] };
    const a = { ...t, dueAt: day },
      b = { ...t, id: "b", sourceId: "b" },
      c = { ...t, id: "c", sourceId: "c" };
    const g = groupsFor(
      [a, b, c],
      (task) => (task === a ? m : task === b ? { ...m, waits: [parallel] } : { ...m, day: "", waits: [parallel] }),
      day,
    );
    expect(g.due).toEqual([a]);
    expect(g.plan).toEqual([b]);
    expect(g.waiting).toEqual([c]);
  });
  it("已完成和已放弃的任务不会因旧催办重返今日", () => {
    const m = { ...emptyMeta(), day, waits: [wait] };
    const done = { ...t, completed: true, status: "completed" as const },
      abandoned = { ...t, status: "abandoned" as const };
    const g = groupsFor([done, abandoned], () => m, day);
    expect(g.done).toEqual([done]);
    expect(g.due).toEqual([]);
  });
  it("不必在日志里打 TODO 就能捕捉口语里的后续承诺", () => {
    const implicit = "VX74 防水接头耐温偏低，周一得找结构组复核报告";
    const text =
      "待确认：验证 VX74 水密探头安装间距。\n" +
      implicit +
      "。规范不得确认缺失信息。明天要问结构组验收时间。周五得催供应商。";
    const clues = extractClues([{ id: "sample", title: "试装", text }]).map((clue) => clue.material.text);
    expect(clues).toEqual([
      "待确认：验证 VX74 水密探头安装间距",
      implicit,
      "明天要问结构组验收时间",
      "周五得催供应商",
    ]);
  });
  it("专题按每项行动检索，不遗漏靠后的任务，也不叠加不同标题的泛词", () => {
    const late = { ...journal, body: "记录 VX74 水密探头的实测间距" };
    const irrelevant = { ...journal, record: { ...journal.record, id: "other" }, body: "外观报告填写规则" };
    const subjects = [
      "BEV",
      "左门检查外观",
      "核对试验报告",
      "电池接线",
      "更新管路",
      "检查支架",
      "验收 VX74 水密探头",
    ];
    expect(assembleMaterials(subjects, [irrelevant, late], [], [], day).recent.map((item) => item.text)).toEqual([
      late.body,
    ]);
  });
  it("检索靠后行动的独有型号，其他检索失败时保留已取得的结果", async () => {
    const late = {
      id: "late-spec",
      documentId: "late",
      provider: "craft",
      libraryId: "lib",
      spaceId: "lib",
      title: "VX74 水密探头规范",
      snippet: "实测水密探头",
      contentType: "document",
    };
    vi.mocked(invoke).mockImplementation(async (_, params) => {
      const query = (params as { query: string }).query;
      if (query === "bev") throw Error("本地检索暂不可用");
      return query === "vx74" ? [late] : [];
    });
    const tasks = Array.from({ length: 27 }, (_, index) => "QA" + index + " 安装复核");
    tasks.push("VX74 水密探头");
    expect((await queryMaterials("BEV", null, tasks)).items.map((material) => material.title)).toEqual([
      late.title,
    ]);
  });
  it("同一日志已关联的不同摘录分别保留，不额外显示自动召回的重复卡片", () => {
    const original = { id: JSON.stringify(["journal", journal.libraryId, journal.record.id]), text: journal.body };
    const excerpts = ["待确认：验证 VX74 间距", "周一得找结构组提供耐温报告"].map((text, index) => ({
      id: "quote-" + index,
      originId: original.id,
      journalId: journal.record.id,
      title: "试装",
      text,
      date: day,
    }));
    const result = assembleMaterials("VX74", [{ ...journal, body: "VX74 试装" }], [], excerpts, day);
    expect(result.recent.map((material) => material.text)).toEqual(excerpts.map((quote) => quote.text));
  });
  it("原段落稳定去重，具体尺寸可匹配不同措辞的滴答任务", () => {
    const source = { id: "src", title: "试装", text: journal.body + "。\n- [x] 完成试装。" };
    const clues = extractClues([source, source]);
    expect(clues).toHaveLength(1);
    expect(matchExisting(clues[0], [t])).toEqual([t]);
  });
  it("同型号但交付对象不同的线索不推荐关联到同一任务", () => {
    const [clue] = extractClues([{ id: "log", title: "现场", text: "VX74 售后工位，周二得复核绝缘夹具" }]);
    const differentTask = { ...t, title: "VX74 防水接头耐温偏低，周一得找结构组复核报告" };
    expect(matchExisting(clue, [differentTask])).toEqual([]);
    const [sameWeekday] = extractClues([{ id: "log2", title: "现场", text: "VX74 售后工位，周一得复核绝缘夹具" }]);
    expect(matchExisting(sameWeekday, [differentTask])).toEqual([]);
    const [sameVerb] = extractClues([{ id: "log3", title: "现场", text: "待确认：VX74 绝缘夹具需要明天提供" }]);
    const differentDeliverable = { ...t, title: "VX74 耐温报告需要明天提供" };
    expect(matchExisting(sameVerb, [differentDeliverable])).toEqual([]);
  });
  it("拒绝虚构引用，对原话未包含的数值标记待核实", async () => {
    const sources: Material[] = [{ id: "rec", title: "录音", text: "基本满足要求" }];
    vi.mocked(invoke).mockResolvedValue({
      items: [
        { source: "1", text: "实测 210mm", quote: "基本满足要求" },
        { source: "1", text: "其他结论", quote: "没有说过" },
      ],
    });
    expect(await generate("draft", sources)).toEqual([
      { source: "rec", text: "实测 210mm", quote: "基本满足要求", verify: true },
    ]);
  });
  it("工程尺寸单位发生变化时标记待核实", async () => {
    const sources: Material[] = [
      { id: "record", title: "实测", text: "实测间距为 120 mm，温度为 30 °C，低温上限 ≤ −30 ℃" },
    ];
    vi.mocked(invoke).mockResolvedValue({
      items: [
        { source: "1", text: "间距为 120cm", quote: "实测间距为 120 mm" },
        { source: "1", text: "间距为 120mm", quote: "实测间距为 120 mm" },
        { source: "1", text: "间距为 120 ㎝", quote: "实测间距为 120 mm" },
        { source: "1", text: "温度为 −30 ℃", quote: "温度为 30 °C" },
        { source: "1", text: "温度为 30 ℃", quote: "温度为 30 °C" },
        { source: "1", text: "间距须 ≤ 120mm", quote: "实测间距为 120 mm" },
        { source: "1", text: "≥ −30 ℃", quote: "低温上限 ≤ −30 ℃" },
        { source: "1", text: "−30 ℃", quote: "低温上限 ≤ −30 ℃" },
        { source: "1", text: "<= -30 °C", quote: "低温上限 ≤ −30 ℃" },
      ],
    });
    expect((await generate("draft", sources)).map((item) => item.verify)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
  });
  it("备料排除只共享泛词的日志，保留同型号现场记录与早期规范", () => {
    const docs = [
      { id: "bios", title: "BIOS 更新", text: "整理开发流程经验", date: day },
      { id: "field", title: "T29 尾盖检查", text: "T29 现场", date: day },
      { id: "spec", title: "T29 尾盖设计标准", text: "T29 线束", date: "2024-01-01" },
    ];
    const pack = assembleMaterials("T29 加速度传感器尾盖供应商开发流程沉淀", [], docs, [], day);
    expect(pack.recent.map((m) => m.id)).toEqual(["field"]);
    expect(pack.long.map((m) => m.id)).toEqual(["spec"]);
  });
  it("默认收合线索，关联已有任务只追加来源，不创建任务或改变排期", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ state: "prepared", id: "receipt" })
      .mockResolvedValueOnce({ state: "confirmed", id: "receipt" });
    let meta = emptyMeta();
    await render(
      <ActionHarvester
        tasks={[t]}
        journals={[journal]}
        scope={null}
        libraries={[]}
        day={day}
        onUpdate={async (_, f) => {
          meta = f(meta);
        }}
        onRefresh={async () => {}}
        onSelect={() => {}}
        revision={0}
      />,
    );
    const toggle = button("行动捕手 · 1 条");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await click(button("关联并补充至已有任务"));
    expect(meta.links.length).toBe(1);
    expect(meta.note).toContain("120mm");
    expect(meta.day).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.map((call) => (call[1] as any)?.args?.action)).not.toContain("createTask");
  });
  it("线索只展示来源标签，点开后才挂载日志照片预览", async () => {
    const item = {
      ...journal,
      record: {
        ...journal.record,
        attachments: [{ hash: "photo", name: "照片.jpg", size: 24, image: true }],
      },
    };
    const material: Material = {
      id: "quote",
      originId: JSON.stringify(["journal", item.libraryId, item.record.id]),
      journalId: item.record.id,
      title: "现场日志",
      text: item.body,
    };
    await render(<Materials items={[material]} journals={[item]} appearance="clue" />);
    const source = button("现场日志");
    expect(source.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".aw-media-strip")).toBeNull();
    await click(source);
    expect(source.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".aw-media-strip")).not.toBeNull();
    await click(source);
    expect(host.querySelector(".aw-media-strip")).toBeNull();
  });
  it("跨清单同名任务要求明确选择，选项标明清单", async () => {
    const sameTitle = {
      ...t,
      id: "same-id",
      sourceId: "same-source",
      collectionId: "second",
      collectionName: "第二清单",
    };
    await render(
      <ActionHarvester
        tasks={[t, sameTitle]}
        journals={[journal]}
        scope={null}
        libraries={[dida]}
        day={day}
        onUpdate={async () => {}}
        onRefresh={async () => {}}
        onSelect={() => {}}
        revision={0}
      />,
    );
    await click(button("行动捕手"));
    expect(button("关联并补充至已有任务")).toBeUndefined();
    expect(host.querySelector('select[aria-label="关联已有任务"]')).toBeNull();
    await click(button("发现 2 项相似任务"));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="关联已有任务"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "选择已有任务",
      t.title + " · T29 · 工作",
      t.title + " · 第二清单 · 工作",
    ]);
    await act(async () => {
      select.value = identity(sameTitle);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("关联并补充至已有任务")).toBeDefined();
  });
  it("从跨库笔记保留复选框和行边界，只有未完成原句进入候选", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "block",
        spaceId: "craft",
        provider: "craft",
        title: "试装笔记",
        snippet: "- [ ] 将图纸交给结构组\n- [x] 提交扭矩表",
      },
    ]);
    await render(
      <ActionHarvester
        tasks={[]}
        journals={[]}
        scope={null}
        libraries={[dida]}
        day={day}
        onUpdate={async () => {}}
        onRefresh={async () => {}}
        onSelect={() => {}}
        revision={0}
      />,
    );
    expect(button("行动捕手 · 1 条")).toBeDefined();
    await click(button("行动捕手"));
    const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="候选行动标题"]');
    expect(title?.value).toBe("将图纸交给结构组");
    expect(host.textContent).toContain("- [ ] 将图纸交给结构组");
    expect(host.textContent).not.toContain("提交扭矩表");
  });
  it("临时状态无法确认时用原请求恢复排期，不重复采纳", async () => {
    const ids: string[] = [];
    vi.mocked(invoke).mockImplementation(async (_command, params) => {
      if (workbenchAction(params) === "createTask") {
        ids.push((params as { args: { requestId: string } }).args.requestId);
        return ids.length === 1 ? { state: "unknown" } : { state: "confirmed", task: t };
      }
      return [];
    });
    let meta = emptyMeta();
    await render(
      <ActionHarvester
        tasks={[]}
        journals={[journal]}
        scope={null}
        libraries={[dida]}
        day={day}
        onUpdate={async (_, update) => {
          meta = update(meta);
        }}
        onRefresh={async () => {}}
        onSelect={() => {}}
        revision={0}
      />,
    );
    await click(button("行动捕手"));
    await click(button("采纳并排入今天"));
    expect(button("采纳并排入今天")).toBeUndefined();
    expect(button("关联并补充至已有任务")).toBeUndefined();
    await click(button("核对采纳回执"));
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(meta.day).toBe(day);
    expect(meta.links).toHaveLength(1);
  });
  it("已知远端任务 ID 的核对抛错后，仍只允许采用同一个来源", async () => {
    vi.mocked(invoke).mockImplementation(async (_command, params) => {
      if (workbenchAction(params) === "createTask") return { state: "unknown", sourceId: "new" };
      return [];
    });
    const props = {
      journals: [journal],
      scope: null,
      libraries: [dida],
      day,
      onUpdate: async () => {},
      onRefresh: async () => {},
      onSelect: () => {},
      revision: 0,
    };
    await render(<ActionHarvester {...props} tasks={[]} />);
    await click(button("行动捕手"));
    await click(button("＋ 采纳到待办"));
    const matchingTitle = extractClues([{ id: "j", title: "日志", text: journal.body }])[0].title;
    await render(
      <ActionHarvester
        {...props}
        tasks={[
          { ...t, title: matchingTitle, sourceId: "old" },
          { ...t, id: "new-id", title: matchingTitle, sourceId: "new" },
        ]}
      />,
    );
    vi.mocked(invoke).mockRejectedValueOnce(new Error("网络中断"));
    await click(button("核对采纳回执"));
    const adopt = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("采用已同步的任务"));
    expect(adopt).toHaveLength(1);
    expect(adopt[0].textContent).toMatch(/new$/);
  });
  it("临近编号不会误入备料，近期固定现场保留在近期分组", () => {
    const recent = { id: "field", title: "现场记录", text: "T29 120mm", date: day, journalId: "record" };
    const wrong = { id: "wrong", title: "其他图纸", text: "T290 1120mm", date: day };
    const old = { id: "old", title: "旧日志", text: "原文", date: "2024-02-01", journalId: "old-record" };
    const pack = assembleMaterials("T29 核对 120mm 安装间距", [], [wrong], [recent, old], day);
    expect(pack.recent).toEqual([recent]);
    expect(pack.long).toEqual([]);
    expect(pack.related).toEqual([old]);
  });

  it("PDF 引用读取指定原页，绕过通用文档打开入口", async () => {
    const result = { id: "attachment-p5", title: "图纸", pageNumber: 5, contentType: "pdf_page" } as SearchResult;
    const open = vi.fn();
    vi.mocked(invoke).mockResolvedValue({ pageNumber: 5, text: "原页文字" });
    await render(
      <Materials items={[{ id: "m", title: "现场图纸", text: "摘要", result }]} journals={[]} onOpen={open} />,
    );
    await click(button("打开来源 · 第 5 页"));
    expect(invoke).toHaveBeenCalledWith("local_pdf_page_preview", { resultId: result.id, pageNumber: 5 });
    expect(host.textContent).toContain("原页文字");
    expect(open).not.toHaveBeenCalled();
  });
  it("同一日相同进展重复记入使用同一个回执 ID，显示同步警告", async () => {
    const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    const ids: string[] = [];
    vi.mocked(invoke).mockImplementation(((_command: string, params: { record: { id: string } }) => {
      ids.push(params.record.id);
      return Promise.resolve({ id: params.record.id, warning: "同步等待网络" });
    }) as typeof invoke);
    expect(await archiveAction("task-1", "已核对现场照片", day)).toContain("同步等待网络");
    await archiveAction("task-1", "已核对现场照片", day);
    await archiveAction("task-1", "已收到结构回复", day);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).not.toBe(ids[2]);
  });
  it("只有并行等待的任务仍显示在专题下一步行动", async () => {
    dashboard.tasks = [t];
    await write("task." + identity(t), { ...emptyMeta(), waits: [{ ...wait, resolved: day }, parallel] });
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    await click(button("T29"));
    expect(host.querySelector('section[aria-label="下一步行动"]')?.textContent).toContain(t.title);
    expect(host.querySelector('section[aria-label="当前外部阻塞"]')?.textContent).not.toContain(t.title);
    expect(host.textContent).toContain("当前无阻塞项，仍有 1 项并行等回复");
  });
  it("旧催办草稿在对应等待未明时不能追加，标记收到时撤下", async () => {
    let meta: ActionMeta = {
      ...emptyMeta(),
      waits: [wait, parallel],
      draft: { mode: "followup", claims: [{ source: "w", text: "请回复", quote: "支架数模" }], sources: [] },
    };
    await render(
      <ActionDetail
        {...{ task: t, meta, journals: [], scope: null, day, onClose: () => {} }}
        update={async (fn) => {
          meta = fn(meta);
        }}
      />,
    );
    expect(button("复制草稿").disabled).toBe(true);
    await click(button("标记已收到"));
    expect(meta.draft).toBeUndefined();
    expect(meta.waits[1].resolved).toBeUndefined();
  });
  it("两个交付独立收件，专题的阻塞与并行数立即变化", async () => {
    let meta: ActionMeta = { ...emptyMeta(), waits: [wait, parallel] };
    const props = {
      task: t,
      meta,
      update: async (f: (m: ActionMeta) => ActionMeta) => {
        meta = f(meta);
      },
      journals: [],
      scope: null,
      day,
      onClose: () => {},
    };
    await render(<ActionDetail {...props} />);
    await click(button("标记已收到"));
    expect(meta.waits[0].resolved).toBeTruthy();
    expect(meta.waits[1].resolved).toBeUndefined();
    await render(
      <ActionTopic
        topic={{ key: "p", name: "T29", libraryId: "lib", collection: "project" }}
        tasks={[t]}
        meta={() => meta}
        journals={[]}
        scope={null}
        day={day}
      >
        {null}
      </ActionTopic>,
    );
    expect(host.textContent).toContain("当前无阻塞项，仍有 1 项并行等回复（供应商 · 耐温报告）");
    expect(identity(t)).toBe(JSON.stringify(["lib", "a"]));
    await render(<ActionDetail {...props} meta={meta} />);
    await click(button("恢复等待"));
    expect(meta.waits[0].resolved).toBeUndefined();
    expect(meta.waits[1]).toEqual(parallel);
  });
  it("专题证据墙在部分跨库检索失败时，同时保留已找到材料并显示错误提示", async () => {
    const lateSpec = {
      id: "late-spec",
      documentId: "late",
      provider: "craft",
      libraryId: "notes",
      spaceId: "notes",
      title: "VX74 水密探头规范",
      snippet: "实测水密探头间距",
      contentType: "document",
    };
    vi.mocked(invoke).mockImplementation(async (command, params) => {
      if (command === "local_search") {
        const query = (params as { query: string }).query;
        if (query === "bev") throw new Error("本地检索暂不可用");
        return query === "vx74" ? [lateSpec] : [];
      }
      return [];
    });
    const probeTask = { ...t, id: "vx", sourceId: "vx", title: "VX74 水密探头" };
    await render(
      <ActionTopic
        topic={{ key: "bev", name: "BEV", libraryId: "lib", collection: "bev" }}
        tasks={[probeTask]}
        meta={() => emptyMeta()}
        journals={[]}
        scope={null}
        day={day}
      >
        {null}
      </ActionTopic>,
    );
    await click(button("专题素材与证据墙"));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("部分跨库检索失败");
    expect(alert?.textContent).toContain("本地检索暂不可用");
    expect(host.textContent).toContain("VX74 水密探头规范");
  });
  it("已完成任务的旧等待项不触发等待催办红点，也不在已闭环列表显示今天回看", async () => {
    const completedTask = { ...t, completed: true, status: "completed" as const };
    dashboard.tasks = [completedTask];
    const today = new Intl.DateTimeFormat("sv-SE").format(new Date());
    await write("task." + identity(completedTask), {
      ...emptyMeta(),
      waits: [{ ...wait, review: today }],
    });
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    const waitingNav = button("等待催办");
    expect(waitingNav.querySelector(".aw-alert-dot")).toBeNull();
    await click(button("已闭环"));
    expect(host.textContent).toContain(completedTask.title);
    expect(host.textContent).not.toContain("今天回看");
  });
  it("等待催办视图按最早回看日升序排列", async () => {
    const laterTask = { ...t, id: "later", sourceId: "later", title: "Alpha 晚回看任务" };
    const urgentTask = { ...t, id: "urgent", sourceId: "urgent", title: "Zeta 今天回看任务" };
    dashboard.tasks = [laterTask, urgentTask];
    const today = new Intl.DateTimeFormat("sv-SE").format(new Date());
    await write("task." + identity(laterTask), {
      ...emptyMeta(),
      waits: [{ ...wait, id: "w-later", review: "2099-12-31" }],
    });
    await write("task." + identity(urgentTask), {
      ...emptyMeta(),
      waits: [{ ...wait, id: "w-urgent", review: today }],
    });
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    await click(button("等待催办"));
    const titles = Array.from(host.querySelectorAll('section[aria-label="等待催办"] .aw-row strong')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual([urgentTask.title, laterTask.title]);
  });
  it("行动捕手在刷新时保留已有跨库笔记线索不闪烁，且关联筛选不区分大小写", async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async (_command, params) => {
      if (workbenchAction(params) === "workbenchPassages") {
        calls += 1;
        if (calls === 1) {
          return [
            {
              id: "block-1",
              spaceId: "craft",
              provider: "craft",
              title: "试装笔记",
              snippet: "- [ ] 将图纸交给结构组",
            },
          ];
        }
        return new Promise(() => {});
      }
      return [];
    });
    const upperTask = { ...t, id: "bev-1", sourceId: "bev-1", title: "BEV 电池包支架复核" };
    const props = {
      tasks: [upperTask],
      journals: [],
      scope: null,
      libraries: [dida],
      day,
      onUpdate: async () => {},
      onRefresh: async () => {},
      onSelect: () => {},
    };
    await render(<ActionHarvester {...props} revision={0} />);
    await click(button("行动捕手 · 1 条"));
    expect(host.querySelector('input[aria-label="筛选可关联任务"]')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="关联已有任务"]')!);
    const filterInput = host.querySelector<HTMLInputElement>('input[aria-label="筛选可关联任务"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filterInput, "bev");
      filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="关联已有任务"]')!;
    expect([...select.options].some((option) => option.textContent?.includes("BEV 电池包支架复核"))).toBe(true);
    await render(<ActionHarvester {...props} revision={1} />);
    expect(host.textContent).toContain("- [ ] 将图纸交给结构组");
  });
  it("同一工作台会话内切回同一专题时复用跨库检索缓存，不重复查询 local_search", async () => {
    let searchCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_quick_journal") return { items: [], error: "" };
      if (command === "get_quick_journal_settings") return { settings: { libraryId: "notes" } };
      if (command === "local_search") {
        searchCalls += 1;
        return [];
      }
      return [];
    });
    dashboard.tasks = [t];
    await render(<TaskWorkspace libraries={[dida]} desktopSidebarVisible />);
    await click(button("T29"));
    const afterFirstVisit = searchCalls;
    expect(afterFirstVisit).toBeGreaterThan(0);
    await click(button("← 今日聚焦"));
    await click(button("T29"));
    expect(searchCalls).toBe(afterFirstVisit);

    // Refocusing invalidates the cache even when the topic stays on screen.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(searchCalls).toBeGreaterThan(afterFirstVisit);
  });
});
