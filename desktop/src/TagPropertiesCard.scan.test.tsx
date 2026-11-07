// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TagPropertiesCard } from "./TagPropertiesCard";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (name: string) => act(async () => {
  root.render(<TagPropertiesCard
    tag={{ name, normalizedName: name, count: 2 }} color="#337bc1" description={name + " 定义"}
    groupLabel="未分组" libraryCount={1} lastUpdatedLabel="今天" relatedTags={[]}
    favorite={false} onChangeColor={() => {}} onChangeDescription={() => {}}
    onToggleFavorite={() => {}} onSelectRelatedTag={() => {}}
  />);
});
it("keeps properties separate from the dedicated scan panel", async () => {
  await render("focus");
  expect(host.querySelector('[aria-label="focus 标签属性"]')).not.toBeNull();
  expect(host.textContent).toContain("focus 定义");
  expect(host.querySelector(".tag-content-scan-entry")).toBeNull();
  expect(host.textContent).not.toContain("复制继续任务");
});
it("leaves editing when switching tags", async () => {
  await render("focus");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑属性"]')!.click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="标签说明"]')?.value).toBe("focus 定义");
  await render("another");
  expect(host.querySelector('[aria-label="标签说明"]')).toBeNull();
  expect(host.textContent).toContain("another 定义");
  expect(host.textContent).not.toContain("focus 定义");
});
