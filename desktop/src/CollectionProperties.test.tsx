// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionProperties } from "./CollectionProperties";
import { CollectionDestination } from "./CollectionDestination";
import type { ComponentProps } from "react";

let container: HTMLDivElement;
let root: Root;
const save = vi.fn(async () => {});
const move = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<>
    <dl>
      <CollectionProperties status="unread" tags={["资料"]} options={["资料", "学习"]} disabled={false} icon={() => <span aria-hidden="true">○</span>} save={save}/>
      <CollectionDestination libraries={[]} disabled={false} onChange={move} onReview={() => {}}/>
    </dl>
    <button aria-label="预览外部按钮">其他操作</button>
  </>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
async function open(label: string) {
  await act(async () => { button(label).focus(); button(label).click(); });
}
async function focus(element: HTMLElement) { await act(async () => element.focus()); }
async function renderDestination(props:Partial<ComponentProps<typeof CollectionDestination>>) {
  await act(async () => root.render(<div className="collections-workspace"><dl><CollectionDestination libraries={[]} disabled={false} onChange={move} onReview={() => {}} {...props}/></dl></div>));
}

it("uses an unregistered default Obsidian vault without showing a Hub selection or library icon", async () => {
  await renderDestination({defaultConfig:{mode:"obsidian",vaultPath:"D:\\Notes\\ZhiHu"}});
  expect(button("选择保存资料库").textContent).toContain("Obsidian / ZhiHu");
  expect(button("选择保存资料库").title).toBe("D:\\Notes\\ZhiHu");
  expect(container.querySelector(".library-icon")).toBeNull();
  await open("选择保存资料库");
  const selected=container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!;
  expect(selected.textContent).toContain("本地默认：Obsidian / ZhiHu");
  await act(async()=>selected.click());
  expect(move).not.toHaveBeenCalled();
});

it("keeps the local default checked and cannot deselect it while adding copies", async () => {
  await renderDestination({defaultConfig:{mode:"obsidian",vaultPath:"D:/Notes/ZhiHu"},storageLocation:{kind:"hub",name:"Hub 本地数据库",isDefault:false}});
  expect(button("选择保存资料库").textContent).toContain("Hub 本地数据库");
  await open("选择保存资料库");
  expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("本地默认：Obsidian / ZhiHu");
  await act(async()=>button("默认保存位置").click());
  expect(move).not.toHaveBeenCalled();
});

it("shows the actual saved unregistered vault when the default has changed", async () => {
  await renderDestination({defaultConfig:{mode:"database",vaultPath:""},storageLocation:{kind:"obsidian",name:"ZhiHu",path:"D:/Notes/ZhiHu",isDefault:false}});
  expect(button("选择保存资料库").textContent).toContain("Obsidian / ZhiHu");
  await open("选择保存资料库");
  const selected=container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!;
  expect(selected.textContent).toContain("本地默认：Hub 本地数据库");
  expect(selected.disabled).toBe(true);
  expect(button("默认保存位置").getAttribute("aria-selected")).toBe("true");
});

it("uses registered library icons and the matching default library without a duplicate entry", async () => {
  const libraries=[{id:"main",provider:"obsidian" as const,name:"Main",location:"d:/notes/zhihu/",connected:true,documentCount:0,excludedPaths:[]},{id:"craft",provider:"craft" as const,name:"Craft",connected:true,documentCount:0,excludedPaths:[]},{id:"dida",provider:"dida365" as const,name:"滴答清单",connected:true,documentCount:0,excludedPaths:[]}];
  await renderDestination({libraries,defaultConfig:{mode:"obsidian",vaultPath:"D:\\Notes\\ZhiHu"}});
  expect(button("选择保存资料库").querySelector<HTMLImageElement>(".library-icon img")?.getAttribute("src")).toBe("/icons/library/obsidian.svg");
  await open("选择保存资料库");
  expect(container.querySelector('[aria-label="保存资料库"] .library-icon.craft img')?.getAttribute("src")).toBe("/icons/library/craft.svg");
  expect(container.querySelector('[aria-label="保存资料库"] .library-icon.dida365 img')?.getAttribute("src")).toBe("/icons/library/dida365.svg?v=2");
  expect([...container.querySelectorAll('[role="option"]')].filter(b=>b.textContent?.includes("Main"))).toHaveLength(1);
});

it("keeps status choices open for internal focus and closes when keyboard focus leaves the row", async () => {
  await open("阅读状态");
  const menu = container.querySelector('[aria-label="选择阅读状态"]')!;
  await focus(menu.querySelector<HTMLButtonElement>('[role="option"]')!);
  expect(menu.isConnected).toBe(true);
  await focus(button("编辑标签"));
  expect(container.querySelector('[aria-label="选择阅读状态"]')).toBeNull();
  expect(button("阅读状态").getAttribute("aria-expanded")).toBe("false");
  expect(save).not.toHaveBeenCalled();
});

it("keeps tag editing open during selection and closes on focus loss without another save", async () => {
  await open("编辑标签");
  const field = container.querySelector<HTMLInputElement>('[aria-label="搜索或创建标签"]')!;
  expect(document.activeElement).toBe(field);
  const option = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="标签选项"] button')].find(b => b.textContent === "学习")!;
  await act(async () => { option.focus(); option.click(); });
  expect(save).toHaveBeenCalledWith("unread", ["资料", "学习"]);
  expect(field.isConnected).toBe(true);
  await focus(button("预览外部按钮"));
  expect(container.querySelector('[aria-label="搜索或创建标签"]')).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});

it("closes status choices on an outside pointer even inside the properties section, and on window blur", async () => {
  await open("阅读状态");
  await act(async () => button("编辑标签").dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(container.querySelector('[aria-label="选择阅读状态"]')).toBeNull();
  await open("阅读状态");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector('[aria-label="选择阅读状态"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("closes the destination menu on focus loss or window blur without changing storage", async () => {
  await open("选择保存资料库");
  await focus(container.querySelector<HTMLButtonElement>('[aria-label="保存资料库"] button')!);
  expect(container.querySelector('[aria-label="保存资料库"]')).toBeTruthy();
  await focus(button("预览外部按钮"));
  expect(container.querySelector('[aria-label="保存资料库"]')).toBeNull();
  await open("选择保存资料库");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector('[aria-label="保存资料库"]')).toBeNull();
  expect(move).not.toHaveBeenCalled();
});

it("opens tag editing after status focus moves away, and dismisses a field blurred to no target", async () => {
  await open("阅读状态");
  await open("编辑标签");
  expect(container.querySelector('[aria-label="选择阅读状态"]')).toBeNull();
  const field = container.querySelector<HTMLInputElement>('[aria-label="搜索或创建标签"]')!;
  expect(field).toBeTruthy();
  await act(async () => field.blur());
  expect(container.querySelector('[aria-label="搜索或创建标签"]')).toBeNull();
});

it("keeps the verified destination and moves detailed progress out of the property row",async()=>{
  await renderDestination({storageLocation:{kind:"obsidian",name:"ZhiHu",path:"D:/Notes/ZhiHu"},operation:{action:"move",target:"craft",phase:"planning",error:"",detail:"使用归档技能整理内容"}});
  expect(container.textContent).toContain("Obsidian / ZhiHu");
  expect(container.textContent).not.toContain("使用归档技能整理内容");
  expect(container.textContent).not.toContain("正在处理");
});

it("shows all copies and allows another library selection while one is running", async () => {
 const libraries=[{id:"craft",provider:"craft" as const,name:"Craft",connected:true,documentCount:0,excludedPaths:[]},{id:"dida",provider:"dida365" as const,name:"滴答",connected:true,documentCount:0,excludedPaths:[]}];
 await renderDestination({libraries,storageLocations:[{kind:"obsidian",name:"Local",path:"D:/Local"},{kind:"craft",name:"Craft",libraryId:"craft",copyState:"queued"}],operation:{action:"move",target:"craft",phase:"writing",error:""}});
 expect(button("选择保存资料库").disabled).toBe(false);
 expect(button("选择保存资料库").textContent).toContain("Obsidian / Local");
 expect(button("选择保存资料库").textContent).toContain("Craft");
 await open("选择保存资料库");
 expect(container.querySelector('[role="listbox"]')?.getAttribute("aria-multiselectable")).toBe("true");
 const options=[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
 expect(options.find(b=>b.textContent==="Craft")?.disabled).toBe(true);
 await act(async()=>options.find(b=>b.textContent==="滴答")!.click());
 expect(move).toHaveBeenCalledWith("dida");
 expect(container.querySelector('[role="listbox"]')).not.toBeNull();
});
it("distinguishes waiting and blocked copies instead of spinning forever", async () => {
 const libraries=[{id:"craft",provider:"craft" as const,name:"Craft",connected:true,documentCount:0,excludedPaths:[]}];
 const remove=vi.fn();
 await renderDestination({libraries,onRemove:remove,storageLocations:[{kind:"craft",name:"Craft",libraryId:"craft",copyState:"blocked"},{kind:"dida365",name:"滴答",copyState:"queued"}],operation:{action:"move",target:"craft",phase:"cleanup",error:"需要处理"}});
 expect(button("选择保存资料库").querySelector('.spin')).toBeNull();
 expect(container.querySelector('[aria-label="需要处理"]')).toBeTruthy();
 expect(container.querySelector('[aria-label="等待保存"]')).toBeTruthy();
 expect(container.textContent).toContain("查看处理记录");
 await open("选择保存资料库");
 const option=[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b=>b.textContent==="Craft")!;
 expect(option.disabled).toBe(false);
 await act(async()=>option.click());
 expect(remove).toHaveBeenCalledWith("craft");
 expect(move).not.toHaveBeenCalled();
});
