// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { archiveAction } from "./ActionJournal";
import { groupsFor, emptyMeta, identity, type ActionMeta } from "./ActionState";
import { extractClues, generate, matchExisting, type Material } from "./ActionEvidence";
import { ActionHarvester } from "./ActionHarvester";
import { ActionDetail } from "./ActionDetail";
import { Materials } from "./ActionMaterials";
import type { SearchResult } from "./SearchTypes";
import { ActionTopic } from "./ActionTopic";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./QuickJournal", () => ({ QuickJournalCard: () => null }));
const profile = vi.hoisted(() => new Map<string, string>());
vi.mock("./UserProfileStorage", () => ({
  userProfileStorage: {
    getItem: (k: string) => profile.get(k) ?? null,
    setItem: (k: string, v: string) => profile.set(k, v),
    flush: async () => {},
  },
  flushUserProfileStorage: async () => {},
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
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue([]);
});

describe("行动工作台", () => {
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
  it("原段落稳定去重，具体尺寸可匹配不同措辞的滴答任务", () => {
    const source = { id: "src", title: "试装", text: journal.body + "。\n- [x] 完成试装。" };
    const clues = extractClues([source, source]);
    expect(clues).toHaveLength(1);
    expect(matchExisting(clues[0], [t])).toEqual([t]);
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
    const toggle = button("发现 1 条");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await click(button("关联并补充至已有任务"));
    expect(meta.links.length).toBe(1);
    expect(meta.note).toContain("120mm");
    expect(meta.day).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.map((call) => (call[1] as any)?.args?.action)).not.toContain("createTask");
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
  });
});
