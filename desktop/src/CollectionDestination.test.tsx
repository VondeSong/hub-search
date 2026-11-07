// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionDestination } from "./CollectionDestination";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof CollectionDestination>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { libraries: [
    { id: "default", name: "ZhiHu", provider: "obsidian", location: "D:/Notes/ZhiHu", connected: true, documentCount: 1, excludedPaths: [] },
    { id: "craft", name: "Main", provider: "craft", connected: true, documentCount: 1, excludedPaths: [] },
    { id: "offline", name: "XV", provider: "craft", connected: false, documentCount: 1, excludedPaths: [] },
  ], defaultConfig: { mode: "obsidian", vaultPath: "D:/Notes/ZhiHu" }, disabled: false, onChange: vi.fn(), onRemove: vi.fn(), onReview: vi.fn(), storageLocations: [
    { kind: "obsidian", name: "ZhiHu", libraryId: "default", path: "D:/Notes/ZhiHu", isDefault: true },
    { kind: "craft", name: "Main", libraryId: "craft", target: "craft", copyState: "saved" },
    { kind: "craft", name: "XV", libraryId: "offline", target: "offline", copyState: "blocked" },
  ] };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function open() {
  await act(async () => root.render(<CollectionDestination {...props} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择保存资料库"]')!.click());
}
function option(name: string) { return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent?.trim() === name)!; }
it("deselects saved and blocked offline destinations while protecting the local default", async () => {
  await open();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="默认保存位置"]')?.disabled).toBe(true);
  expect(option("Main").disabled).toBe(false); expect(option("Main").getAttribute("aria-selected")).toBe("true");
  await act(async () => option("Main").click());
  await act(async () => option("XV").click());
  expect(props.onRemove).toHaveBeenNthCalledWith(1, "craft"); expect(props.onRemove).toHaveBeenNthCalledWith(2, "offline");
  expect(props.onChange).not.toHaveBeenCalled();
  expect(container.textContent).toContain("取消选择不删除已保存的副本");
});
it("adds a deselected connected destination and prevents adding an offline destination", async () => {
  props.storageLocations = [props.storageLocations![0]];
  await open();
  await act(async () => option("Main").click());
  expect(props.onChange).toHaveBeenCalledWith("craft"); expect(props.onRemove).not.toHaveBeenCalled();
  expect(option("XV").disabled).toBe(true);
});
it("allows removing an orphaned target and sends its retained stable identity", async () => {
  props.storageLocations!.push({ kind: "unavailable", name: "旧库", target: "removed-library", copyState: "queued" });
  await open();
  await act(async () => option("旧库").click());
  expect(props.onRemove).toHaveBeenCalledWith("removed-library");
});
it("does not offer a second default destination when two registrations share its physical root", async () => {
  props.libraries.push({ id: "alias", name: "ZhiHu alias", provider: "obsidian", location: "d:\\Notes\\ZhiHu\\", connected: false, documentCount: 1, excludedPaths: [] });
  await open();
  expect([...container.querySelectorAll('[role="option"]')].some(button => button.textContent?.includes("ZhiHu alias"))).toBe(false);
  expect(props.onRemove).not.toHaveBeenCalled();
});
