// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SearchFilterReveal } from "./SearchFilterReveal";
it("keeps filter state mounted but removes closed controls from interaction", async () => {
  const node=document.createElement("div"); const root=createRoot(node);
  const render=(open:boolean)=><SearchFilterReveal open={open}><input defaultValue="保留筛选" /></SearchFilterReveal>;
  try {
    await act(async()=>root.render(render(false)));
    const input=node.querySelector("input");
    expect(node.firstElementChild?.hasAttribute("inert")).toBe(true);
    await act(async()=>root.render(render(true)));
    expect(node.firstElementChild?.hasAttribute("inert")).toBe(false);
    expect(node.querySelector("input")).toBe(input);
    await act(async()=>root.render(render(false)));
    expect(node.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  } finally { await act(async()=>root.unmount()); }
});
