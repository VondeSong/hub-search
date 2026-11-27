// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { MobileInsightList, mobileTasks } from "./MobileInsightTasks";
import {
  useMobileReadingPosition,
  type ReadingAnchor,
} from "./MobileReadingPosition";
import type { Insight } from "./InsightTypes";

const { rows, change, profile, flush } = vi.hoisted(() => ({
  rows: [] as Insight[],
  change: vi.fn(),
  profile: new Map<string, string>(),
  flush: vi.fn(),
}));
vi.mock("./UserProfileStorage", () => ({
  userProfileStorage: {
    getItem: (k: string) => profile.get(k) ?? null,
    setItem: (k: string, v: string) => profile.set(k, v),
  },
  flushUserProfileStorage: flush,
}));
vi.mock("./useInsights", () => ({
  useInsights: () => ({
    items: rows,
    busy: false,
    error: "",
    loading: false,
    change,
    refresh: vi.fn(),
  }),
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  profile.clear();
  flush.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("opens the same local task after repeat conversion and remount", async () => {
  rows.splice(0, rows.length, {
    id: "finding-a",
    workTitle: "原发现",
    processingState: "attention",
    validity: "available",
    snapshot: { text: "依据段落", sourceCitations: [] },
  } as unknown as Insight);
  const open = vi.fn();
  const render = (key: number) =>
    act(async () =>
      root.render(
        <MobileInsightList key={key} openTask={open} advanced={() => {}} />,
      ),
    );
  const press = async (text: string) => {
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === text)!
        .click(),
    );
  };
  await render(1);
  await press("转为任务并打开");
  await render(2);
  await press("打开关联任务");
  expect(open.mock.calls).toEqual([
    ["insight:finding-a"],
    ["insight:finding-a"],
  ]);
  expect(mobileTasks()).toHaveLength(1);
  expect(mobileTasks()[0].note).toBe("依据段落");
});
it("restores the specific matched paragraph even when the article fits the viewport", async () => {
  function Reader({ anchor }: { anchor?: ReadingAnchor }) {
    const ref = useRef<HTMLDivElement>(null);
    const reading = useMobileReadingPosition(ref, "post", "文章");
    const init = useRef(false);
    if (!init.current) {
      reading.pending.current =
        anchor || (reading.bookmark ? { bookmark: reading.bookmark } : null);
      init.current = true;
    }
    return (
      <div ref={ref}>
        <div className="collection-post-text">
          <p>第一个命中</p>
          <p>第二个命中</p>
        </div>
        <output>{reading.bookmark?.paragraph}</output>
      </div>
    );
  }
  await act(async () =>
    root.render(
      <Reader
        key="search"
        anchor={{ query: "命中", occurrence: 1, context: "第二个命中" }}
      />,
    ),
  );
  expect(host.querySelector(".mobile-reading-hit")?.textContent).toBe(
    "第二个命中",
  );
  await act(async () => root.render(<Reader key="resume" />));
  expect(host.querySelector("output")?.textContent).toBe("1");
});

it("schedules a future review and can return the same insight early", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.history.replaceState({ hubMobileRoute: "insights" }, "");
  const item = {
    id: "scheduled",
    workTitle: "发现",
    processingState: "attention",
    validity: "available",
    snapshot: { text: "依据", sourceCitations: [] },
  } as unknown as Insight;
  rows.splice(0, rows.length, item);
  change.mockImplementation(async (target, _, fields) => {
    target.processingState = fields.state;
    target.snoozeUntil = fields.snoozeUntil || null;
  });
  const open = vi.fn();
  await act(async () =>
    root.render(<MobileInsightList openTask={open} advanced={() => {}} />),
  );
  const click = async (label: string) =>
    act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === label)!
        .click(),
    );
  await click("稍后再看");
  await click("一周后");
  expect(change).toHaveBeenCalledWith(item, "insightStatus", expect.objectContaining({ state: "later" }));
  await act(async () => new Promise<void>((r) => setTimeout(r, 25)));
  expect(item.snoozeUntil).toBeGreaterThan(Date.now() + 6 * 86400000);
  await click("稍后再看 (1)");
  expect(host.textContent).toContain("修改回看时间");
  await click("修改回看时间");
  expect(host.querySelector<HTMLInputElement>("input[type=datetime-local]")!.valueAsNumber).toBeGreaterThan(Date.now() + 5 * 86400000);
  await click("取消");
  await act(async () => new Promise<void>((r) => setTimeout(r, 25)));
  await click("移回待关注");
  expect(item.processingState).toBe("attention");
  window.history.replaceState({}, "");
});

it("highlights repeated literal hits across inline formatting, including punctuation", async () => {
  const highlights = new Map<string, Range[]>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class { constructor(...ranges: Range[]) { return ranges; } });
  function Reader() {
    const ref = useRef<HTMLDivElement>(null);
    const reading = useMobileReadingPosition(ref, "inline", "文章");
    reading.pending.current = { query: "A+B" };
    return <div ref={ref}><div className="collection-post-text"><p>A<strong>+B</strong> A+B</p></div></div>;
  }
  try {
    await act(async () => root.render(<Reader/>));
    expect(highlights.get("mobile-reading-match")?.map(range => range.toString())).toEqual(["A+B", "A+B"]);
    await act(async () => root.render(null));
    expect(highlights.has("mobile-reading-match")).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});
