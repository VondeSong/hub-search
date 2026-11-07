// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentCitationPreview, citationMatches } from "./AgentCitationPreview";

it("does not choose a first match for repeated or overlapping quotations", () => {
  expect(citationMatches("同句。其他。同句。", "同句。")).toEqual([0, 6]);
  expect(citationMatches("aaa", "aa")).toEqual([0, 1]);
  expect(citationMatches("正文", "")).toEqual([]);
});

it("highlights verified text, clears it for changed sources, and returns without actions", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const onReturn = vi.fn();
  const value = { excerpt: { title: "来源", sourcePath: "来源.md", content: "前文引用后文", startChar: 0, endChar: 6, totalChars: 6, truncated: false }, quote: "引用", onReturn };
  try {
    await act(async () => root.render(<AgentCitationPreview value={value}/>));
    expect(host.querySelector("mark")?.textContent).toBe("引用");
    await act(async () => host.querySelector("button")!.click());
    expect(onReturn).toHaveBeenCalledOnce();
    await act(async () => root.render(<AgentCitationPreview value={{...value,excerpt:{...value.excerpt,content:"来源已改变"}}}/>));
    expect(host.querySelector("mark")).toBeNull();
    expect(host.textContent).toContain("未找到该引用");
    await act(async () => root.render(<AgentCitationPreview value={{...value,excerpt:{...value.excerpt,content:"引用引用"}}}/>));
    expect(host.querySelector("mark")).toBeNull();
    expect(host.textContent).toContain("无法唯一定位");
  } finally { await act(async () => root.unmount()); }
});
