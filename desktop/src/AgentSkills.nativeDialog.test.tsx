// @vitest-environment jsdom
import {act, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {AgentSkills} from "./AgentSkills";
import {useAgentPopover} from "./useAgentPopover";

const {invoke, open} = vi.hoisted(() => ({invoke: vi.fn(), open: vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open}));

// Match the composer's conditional mount: closing its menu removes the manager.
function SkillsMenu() {
  const popover = useAgentPopover();
  const [opened, setOpened] = useState(false);
  return <details ref={popover.ref} onToggle={event => {
    if (event.target === event.currentTarget) setOpened(event.currentTarget.open);
  }}><summary>技能</summary>{opened && <AgentSkills embedded disabled={false} onSelect={vi.fn()}/>}</details>;
}

const inspection = {
  source: null, directory: "D:/methods/review", methodVersion: "method-preview", sourceFingerprint: "fingerprint",
  skill: {name: "review", title: "核对方法", available: true, unavailableReasons: []},
  files: [{path: "SKILL.md", bytes: 20, readable: true}], warnings: [],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockImplementation(async (_name, {args}) => {
    if (args.action === "skills") return {directory: "D:/skills", skills: [], diagnostics: []};
    if (args.action === "skillPackages") return {sources: []};
    if (args.action === "skillPackagePreview") return inspection;
    if (args.action === "skillPackageImport") return {...inspection, source: {
      packageId: "package-review", revision: 1, name: "review", directory: inspection.directory,
      mode: "source", methodVersion: inspection.methodVersion, sourceFingerprint: inspection.sourceFingerprint,
    }};
    throw Error(`Unexpected action: ${args.action}`);
  });
  open.mockReset();
});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function showManager() {
  await act(async () => root.render(<SkillsMenu/>));
  await act(async () => {
    const menu = host.querySelector("details")!; menu.open = true; menu.dispatchEvent(new Event("toggle"));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="管理技能"]')!.click());
}
async function nativeFocusLeaves() {
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    document.body.dispatchEvent(new Event("focusin", {bubbles: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

it("选完文件夹回到 Hub 后，检查结果和保存按钮仍在，点保存才登记", async () => {
  let choose!: (value: string) => void;
  open.mockImplementation(() => new Promise(resolve => {choose = resolve;}));
  await showManager();
  await act(async () => {button("检查方法文件夹").focus(); button("检查方法文件夹").click();});
  await nativeFocusLeaves();
  expect(host.querySelector("details")!.open).toBe(true);
  expect(host.querySelector('[aria-label="技能管理"]')).not.toBeNull();
  await act(async () => choose(inspection.directory));
  expect(host.querySelector('[aria-label="方法包检查结果"]')?.textContent).toContain("核对方法");
  expect(button("保存固定方法包").disabled).toBe(false);
  expect(invoke.mock.calls.some(([, {args}]) => args.action === "skillPackageImport")).toBe(false);
  await act(async () => button("保存固定方法包").click());
  expect(invoke.mock.calls.filter(([, {args}]) => args.action === "skillPackageImport")).toHaveLength(1);
  expect(host.querySelector('[aria-label="已保存方法包"]')).not.toBeNull();
  await act(async () => {window.dispatchEvent(new Event("blur")); await new Promise(resolve => setTimeout(resolve, 0));});
  expect(host.querySelector("details")!.open).toBe(false);
});

it.each(["取消", "失败"])("选目录时%s，回到原页且之后仍能正常关闭菜单", async outcome => {
  let finish!: () => void;
  open.mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => outcome === "取消" ? resolve(null) : reject(Error("目录暂不可读"));
  }));
  await showManager();
  await act(async () => {button("检查方法文件夹").focus(); button("检查方法文件夹").click();});
  await nativeFocusLeaves();
  await act(async () => finish());
  expect(host.querySelector("details")!.open).toBe(true);
  expect(document.activeElement).toBe(button("检查方法文件夹"));
  expect(invoke.mock.calls.some(([, {args}]) => args.action === "skillPackagePreview")).toBe(false);
  if (outcome === "失败") expect(host.querySelector('[role="alert"]')?.textContent).toContain("目录暂不可读");
  await act(async () => {document.body.dispatchEvent(new Event("pointerdown", {bubbles: true})); await new Promise(resolve => setTimeout(resolve, 0));});
  expect(host.querySelector("details")!.open).toBe(false);
});
