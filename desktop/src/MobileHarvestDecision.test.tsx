// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileHarvestDecision, localHarvestReceipts } from "./MobileHarvestDecision";
import { MobileLocalTaskDetail, mobileTasks } from "./MobileInsightTasks";
import type { Clue } from "./ActionEvidence";

const { profile, flush } = vi.hoisted(() => ({ profile: new Map<string, string>(), flush: vi.fn() }));
vi.mock("./UserProfileStorage", () => ({
  userProfileStorage: { getItem: (key: string) => profile.get(key) ?? null, setItem: (key: string, value: string) => profile.set(key, value) },
  flushUserProfileStorage: flush,
}));

let root: Root, host: HTMLElement;
const saved = vi.fn(), open = vi.fn();
const first: Clue = { key: "one", title: "first", material: { id: "doc", title: "source", text: "first sentence" } };
const second: Clue = { key: "two", title: "second", material: { ...first.material, text: "second sentence" } };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  profile.clear(); flush.mockReset(); saved.mockClear(); open.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render(clue: Clue, showReceipt = false) {
  const receipt = showReceipt ? localHarvestReceipts(mobileTasks()).find(row => row.entry.key === clue.key) : undefined;
  await act(async () => root.render(<MobileHarvestDecision key={clue.key} clue={clue} receipt={receipt} onSaved={saved} onOpen={open}/>));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("opens both receipts on the same task and preserves independent quotes and their destination", async () => {
  await render(first);
  expect(host.querySelector("blockquote")?.textContent).toContain(first.material.text);
  await click("确认清单并新建");
  const id = mobileTasks()[0].id;
  await render(first, true);
  expect(host.querySelector("dl")?.textContent).toContain("本机任务");
  await click("打开对应任务");
  await render(second); await click("补充已有任务");
  expect(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  await act(async () => {
    const select = host.querySelector("select")!;
    select.value = id; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("确认清单并补充"); await render(second, true);
  expect(host.textContent).toContain("已补充已有任务");
  await click("打开对应任务");
  expect(open.mock.calls).toEqual([[id], [id]]);
  expect(mobileTasks()).toHaveLength(1);
  expect(mobileTasks()[0].harvestEntries?.map(entry => entry.quote)).toEqual([first.material.text, second.material.text]);
});

it("retries a pending profile transaction before issuing the receipt and never duplicates its task", async () => {
  flush.mockRejectedValueOnce(Error("offline")).mockRejectedValueOnce(Error("offline")).mockResolvedValue(undefined);
  await render(first); await click("确认清单并新建"); await click("确认清单并新建");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("offline");
  expect(saved).not.toHaveBeenCalled();
  await click("确认清单并新建");
  expect(saved).toHaveBeenCalledOnce();
  expect(mobileTasks()).toHaveLength(1);
  expect(localHarvestReceipts(mobileTasks())).toHaveLength(1);
});

it("restores the progress draft and retries a failed save without appending it twice", async () => {
  await render(first); await click("确认清单并新建");
  const detail = () => act(async () => root.render(<MobileLocalTaskDetail task={mobileTasks()[0]} back={vi.fn()} onChange={vi.fn()}/>));
  await detail();
  const area = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "follow up");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render(first, true); await detail();
  expect(host.querySelector("textarea")!.value).toBe("follow up");
  flush.mockRejectedValueOnce(Error("offline"));
  await click("保存备注"); expect(host.querySelector("[role=alert]")?.textContent).toContain("offline");
  await click("保存备注");
  expect(mobileTasks()[0].progressNotes).toEqual(["follow up"]);
  expect(host.querySelector("textarea")!.value).toBe("");
  expect(host.querySelector("[role=alert]")).toBeNull();
});

it("keeps a candidate's draft across back navigation without applying it to a different candidate", async () => {
  const drafts = new Map();
  const show = async (clue: Clue) => act(async () => root.render(
    <MobileHarvestDecision key={clue.key} clue={clue} drafts={drafts} onOpen={open} onSaved={saved}/>
  ));
  await show(first);
  await click("补充已有任务");
  await show(second);
  expect(host.querySelector("[aria-pressed=true]")?.textContent).toBe("新建任务");
  await show(first);
  expect(host.querySelector("[aria-pressed=true]")?.textContent).toBe("补充已有任务");
  await click("新建任务"); await click("确认清单并新建");
  expect(drafts.has(first.key)).toBe(false);
});
