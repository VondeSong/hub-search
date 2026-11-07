// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LibraryAddActions } from "./LibraryAddActions";
import { INHERIT_LIBRARY_POLICY } from "./LibraryManagement";
it("submits the selected policy with distinct start and later intent", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); const root = createRoot(container); const add = vi.fn();
  const policy = { ...INHERIT_LIBRARY_POLICY, imageOcr: false, imageDownload: true };
  await act(async () => root.render(<LibraryAddActions busy={false} contentPolicy={policy} onAdd={add} />));
  await act(async () => container.querySelectorAll("button")[1].click());
  expect(add).toHaveBeenLastCalledWith({ startNow: false, contentPolicy: policy });
  await act(async () => container.querySelectorAll("button")[0].click());
  expect(add).toHaveBeenLastCalledWith({ startNow: true, contentPolicy: policy });
  await act(async () => root.unmount());
});
