// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useResultContextMemory } from "./useResultContextMemory";

it("keeps a new selection when recording a click refreshes the result array", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  function Sample() {
    const [index, setIndex] = useState(0);
    const [revision, setRevision] = useState(0);
    const items = [{ entityKey: "first" }, { entityKey: "second" }];
    const memory = useResultContextMemory("click-refresh", items, index, true, setIndex);
    return <div ref={memory.ref}><output>{items[index]?.entityKey}</output><button onClick={() => { setIndex(1); setRevision(revision + 1); }}>select</button></div>;
  }
  try {
    await act(async () => root.render(<Sample />));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("output")!.textContent).toBe("second");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("restores a row by identity and its scroll position after an asynchronous context switch", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const rows = [{ entityKey: "a" }, { entityKey: "b" }];
  function Sample({ context, items, ready = true }: { context: string; items: typeof rows; ready?: boolean }) {
    const [index, setIndex] = useState(0);
    const memory = useResultContextMemory(context, items, index, ready, setIndex);
    return <div ref={memory.ref} onScroll={memory.onScroll}><output>{items[index]?.entityKey}</output><button onClick={() => setIndex(1)}>select</button></div>;
  }
  try {
    await act(async () => root.render(<Sample context="test-home" items={rows} />));
    await act(async () => host.querySelector("button")!.click());
    const pane = host.firstElementChild as HTMLElement;
    pane.scrollTop = 270;
    await act(async () => pane.dispatchEvent(new Event("scroll")));
    await act(async () => root.render(<Sample context="test-tags" items={rows} />));
    expect(host.querySelector("output")!.textContent).toBe("a");
    await act(async () => root.render(<Sample context="test-home" items={[]} ready={false} />));
    await act(async () => root.render(<Sample context="test-home" items={[rows[1], rows[0]]} />));
    expect(host.querySelector("output")!.textContent).toBe("b");
    expect((host.firstElementChild as HTMLElement).scrollTop).toBe(270);
    await act(async () => root.render(<Sample context="test-tags" items={rows} />));
    await act(async () => root.render(<Sample context="test-home" items={[rows[0]]} />));
    expect(host.querySelector("output")!.textContent).toBe("a");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
