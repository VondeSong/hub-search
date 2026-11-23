// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewTocPopover } from "./PreviewTocPopover";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function Harness({ html, contentKey = "doc-1" }: { html: string; contentKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <PreviewTocPopover contentRef={ref} contentKey={contentKey} />
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

describe("PreviewTocPopover", () => {
  it("stays hidden when fewer than two content headings exist", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(<Harness html='<h1 class="preview-title">页面标题</h1><h2>唯一小节</h2><p>正文</p>' />),
    );
    expect(container.querySelector(".preview-toc-trigger")).toBeNull();

    await act(async () => root.unmount());
  });

  it("lists headings, jumps on click, and closes on Escape returning focus to trigger", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <Harness html="<h1>总览</h1><h2>实现细节</h2><h3>边界检查</h3><p>内容</p>" />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>(".preview-toc-trigger")!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>(".preview-toc-item"));
    expect(items.map((el) => el.textContent)).toEqual(["总览", "实现细节", "边界检查"]);
    expect(items[0].className).toContain("level-1");
    expect(items[1].className).toContain("level-2");
    expect(items[2].className).toContain("level-3");

    const secondHeading = container.querySelector("h2")!;
    const scrollIntoView = vi.fn();
    secondHeading.scrollIntoView = scrollIntoView;
    await act(async () => items[1].click());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".preview-toc-popover")).toBeNull();

    await act(async () => trigger.click());
    expect(container.querySelector(".preview-toc-popover")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".preview-toc-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => root.unmount());
  });

  it("flips popover alignment to align-left when tight on the left edge of a narrow preview card", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    function NarrowCardHarness() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <article className="preview-card">
          <div className="preview-actions">
            <PreviewTocPopover contentRef={ref} contentKey="narrow-doc" />
          </div>
          <div ref={ref}>
            <h1>一、架构设计总览</h1>
            <h2>二、模块边界与接口约束说明</h2>
            <h3>三、长标题溢出省略与缩进核对清单</h3>
          </div>
        </article>
      );
    }

    await act(async () => root.render(<NarrowCardHarness />));
    const card = container.querySelector<HTMLElement>(".preview-card")!;
    const wrap = container.querySelector<HTMLElement>(".preview-toc-wrap")!;
    card.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 420, bottom: 700, width: 420, height: 700, x: 0, y: 0, toJSON: () => ({}),
    });
    wrap.getBoundingClientRect = () => ({
      left: 120, top: 10, right: 148, bottom: 38, width: 28, height: 28, x: 120, y: 10, toJSON: () => ({}),
    });

    const trigger = container.querySelector<HTMLButtonElement>(".preview-toc-trigger")!;
    await act(async () => trigger.click());
    const popover = container.querySelector<HTMLDivElement>(".preview-toc-popover")!;
    expect(popover.classList.contains("align-left")).toBe(true);
    expect(Array.from(popover.querySelectorAll(".preview-toc-item")).map((n) => n.textContent)).toEqual([
      "一、架构设计总览",
      "二、模块边界与接口约束说明",
      "三、长标题溢出省略与缩进核对清单",
    ]);

    await act(async () => root.unmount());
  });
});
