// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TagContentScanJoint, type JointTag } from "./TagContentScanJoint";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const copy = vi.fn();
const tag = (name: string): JointTag => ({ tag: name, definitionVersion: 2, definition: { description: "定义说明", libraryIds: ["lib"] } });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockImplementation(async (_, { args }) => { const t = tag(args.tag.toLowerCase()); return { definition: { tag: t.tag, version: t.definitionVersion, definition: t.definition } }; });
  copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (selection?: JointTag[], editable = true) => act(async () => root.render(<TagContentScanJoint tagId="focus" runId="run1" selection={selection} counts={{ pending: 2, recorded: 3, unvisited: 8, excluded: 1, already_tagged: 0, out_of_scope: 4 }} editable={editable} />));
const click = (text: string) => act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!.click());
const input = (value: string) => act(async () => {
  const element = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
});
it("only reads saved definitions and copies explicit versioned selection without writes", async () => {
  await render(); expect(invoke).not.toHaveBeenCalled();
  await input("Second"); await click("核对定义并加入");
  expect(invoke).toHaveBeenCalledWith("tag_assignment", { args: { action: "definition", tag: "Second" } });
  expect(copy).not.toHaveBeenCalled(); await click("复制联合检查任务");
  expect(copy.mock.calls[0][0]).toContain('"additionalTags"');
  expect(copy.mock.calls[0][0]).toContain('"tag": "second"');
  expect(copy.mock.calls[0][0]).toContain('"definitionVersion": 2');
  expect(copy.mock.calls[0][0]).toContain('"runId": "run1"');
  expect(host.textContent).toContain("复制本身不保存选择或修改标签");
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("rejects missing definitions, duplicate tags and the primary tag", async () => {
  await render(); invoke.mockResolvedValueOnce({ definition: null });
  await input("unknown"); await click("核对定义并加入"); expect(host.textContent).toContain("尚未保存补标定义");
  await input("focus"); await click("核对定义并加入"); expect(host.textContent).toContain("不能重复选择");
  await input("second"); await click("核对定义并加入");
  await input("SECOND"); await click("核对定义并加入"); expect(host.querySelectorAll("li")).toHaveLength(1);
});
it("caps selection at four and allows removal before copying", async () => {
  await render();
  for (const n of ["one", "two", "three", "four"]) { await input(n); await click("核对定义并加入"); }
  await input("five"); await click("核对定义并加入"); expect(invoke).toHaveBeenCalledTimes(4);
  await click("移除"); expect(host.querySelectorAll("li")).toHaveLength(3);
});
it("shows fixed selection and honest pair counts without editing or starting analysis", async () => {
  await render([tag("second")], false);
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("已固定选择");
  expect(host.textContent).toContain("已记录（非已批准）");
  expect(host.textContent).toContain("不是笔记数量");
  expect(Array.from(host.querySelectorAll("dt")).find(e => e.textContent === "尚未覆盖")?.nextElementSibling?.textContent).toBe("8");
  expect(invoke).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
});
it("reports clipboard errors without claiming work started", async () => {
  await render([tag("second")]); copy.mockRejectedValueOnce(Error("denied"));
  await click("复制联合检查任务"); expect(host.textContent).toContain("复制失败");
  expect(host.textContent).not.toContain("联合任务已复制");
});
it("ignores a late definition response after leaving the task", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await render(); await input("second"); await click("核对定义并加入");
  await act(async () => root.render(<div>另一个任务</div>));
  await act(async () => resolve({ definition: { tag: "second", version: 2, definition: tag("second").definition } }));
  expect(host.textContent).toBe("另一个任务"); expect(copy).not.toHaveBeenCalled();
});
