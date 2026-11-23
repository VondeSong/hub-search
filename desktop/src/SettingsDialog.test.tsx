// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

describe("SettingsDialog accessibility", () => {
  let root: Root;
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    trigger = document.createElement("button");
    trigger.textContent = "打开设置";
    container = document.createElement("div");
    document.body.append(trigger, container);
    trigger.focus();
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    trigger.remove();
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("offers phone settings without the desktop MCP entry", async () => {
    await act(async () => root.render(
      <SettingsDialog mobile canClose category="libraries" onCategoryChange={() => undefined} onClose={() => undefined}>
        <div>资料库内容</div>
      </SettingsDialog>,
    ));
    const options = [...container.querySelectorAll("option")].map((option) => option.value);
    expect(options).toEqual(["libraries", "cloud", "display", "behavior", "index"]);
    expect(container.textContent).not.toContain("Obsidian");
  });
  it("shows global notices inside the active modal footer", async () => {
    await act(async () => root.render(<SettingsDialog canClose category="codex" onCategoryChange={() => undefined} onClose={() => undefined}><div>设置内容</div></SettingsDialog>));
    await act(async () => window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text: "Codex 设置已保存", tone: "success", duration: 0 } })));
    const footer = container.querySelector<HTMLElement>('.settings-operation-status')!;
    expect(footer.closest('[aria-modal="true"]')).toBeTruthy();
    expect(footer.textContent).toBe("Codex 设置已保存");
    expect(footer.getAttribute("role")).toBe("status");
    await act(async () => window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text: "读取模型失败，请重试", tone: "error", duration: 0 } })));
    expect(footer.textContent).toBe("读取模型失败，请重试");
    expect(footer.getAttribute("role")).toBe("alert");
    expect(footer.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("isolates the background, traps focus and restores the opener", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(
      <>
        <button data-background-action>背景操作</button>
        <SettingsDialog canClose category="display" onCategoryChange={() => undefined} onClose={onClose}>
          <button>最后一个控件</button>
        </SettingsDialog>
      </>,
    ));

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const background = container.querySelector<HTMLElement>('[data-background-action]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("settings-dialog-title");
    expect(document.activeElement).toBe(dialog);
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    background.focus();
    document.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).toBe(dialog);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(document.activeElement).toBe(trigger);
    root = createRoot(container);
  });

  it("wraps keyboard focus through visible accordion headers, skipping collapsed forms", async () => {
    await act(async () => root.render(
      <SettingsDialog canClose category="libraries" onCategoryChange={() => undefined} onClose={() => undefined}>
        <details><summary>Craft</summary><input aria-label="地址" /><details><summary>API 连接</summary><button>保存 API</button></details></details>
      </SettingsDialog>,
    ));
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
    const summary = container.querySelector<HTMLElement>("summary")!;
    close.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(summary);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);
    container.querySelector("details")!.open = true;
    close.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement?.textContent).toBe("API 连接");
  });
  it("lets the native icon crop modal retain focus and Escape handling", async () => {
    const close = vi.fn();
    await act(async () => root.render(<SettingsDialog canClose={false} externalModalOpen category="libraries" onCategoryChange={() => undefined} onClose={close}><div>资料库</div></SettingsDialog>));
    const crop = document.createElement("dialog"); const button = document.createElement("button"); crop.append(button); document.body.append(crop);
    button.focus(); expect(document.activeElement).toBe(button);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); expect(close).not.toHaveBeenCalled();
    crop.remove();
  });

  it("renders the desktop 7-category Base White shell with live search and Escape clear-before-close", async () => {
    const onCategoryChange = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(
      <SettingsDialog canClose category="libraries" onCategoryChange={onCategoryChange} onClose={onClose}>
        <div>当前分类内容</div>
      </SettingsDialog>,
    ));

    const dialog = container.querySelector<HTMLElement>(".settings-desktop-shell")!;
    expect(dialog).not.toBeNull();
    const navButtons = [...container.querySelectorAll<HTMLButtonElement>(".settings-category-tabs button")];
    expect(navButtons.map((btn) => btn.textContent?.trim())).toEqual([
      "资料库", "云同步", "显示", "操作", "模型与运行", "MCP", "数据管理",
    ]);
    expect(container.querySelector(".settings-pane-title")?.textContent).toBe("资料库");

    // Live search matches real categories and jumps on click
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "MCP");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const hits = [...container.querySelectorAll<HTMLButtonElement>(".settings-search-hit")];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((hit) => hit.textContent?.includes("MCP"))).toBe(true);

    // Pressing Escape while search is active clears search instead of closing the dialog
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    // Searching and clicking a hit jumps to that category and clears search
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "快捷键");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const behaviorHit = container.querySelector<HTMLButtonElement>(".settings-search-hit")!;
    await act(async () => behaviorHit.click());
    expect(onCategoryChange).toHaveBeenCalledWith("behavior");
    expect(input.value).toBe("");

    // Pressing Escape when search is empty closes the dialog
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
