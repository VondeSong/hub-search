// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useMobileSearch } from "./useMobileSearch";

it("opens only on demand and restores the previous query when leaving search", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let search: ReturnType<typeof useMobileSearch>;
  let edit: (value: string) => void;
  function Demo() {
    const [query, setQuery] = useState("before"); edit = setQuery;
    const input = useRef<HTMLInputElement>(null);
    search = useMobileSearch({ enabled: true, query, setQuery, input });
    return <input ref={input} value={query} readOnly data-expanded={search.expanded} />;
  }
  try {
    await act(async () => root.render(<Demo />));
    expect(search!.expanded).toBe(false);
    await act(async () => search!.open());
    expect(search!.expanded).toBe(true);
    expect(window.history.state.hubMobileSearch).toBe(true);
    await act(async () => edit!("new search"));
    await act(async () => { expect(search!.consumeBack()).toBe(true); });
    expect(search!.expanded).toBe(false);
    expect(host.querySelector("input")?.value).toBe("before");
    expect(search!.consumeBack()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
