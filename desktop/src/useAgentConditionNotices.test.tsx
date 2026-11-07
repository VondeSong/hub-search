// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAgentConditionNotices } from "./useAgentConditionNotices";
const { listen, show } = vi.hoisted(() => ({ listen: vi.fn(), show: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./useOperationStatus", () => ({ showOperationStatus: show }));
function View() { useAgentConditionNotices(); return null; }
it("coalesces notices and stops a subscription that resolves after unmount", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let receive: (event: { payload: unknown }) => void = () => {};
  let resolve: (stop: () => void) => void = () => {};
  listen.mockImplementation((_, callback) => { receive = callback; return new Promise(done => { resolve = done; }); });
  const host = document.createElement("div"); const root = createRoot(host); const stop = vi.fn();
  try {
    await act(async () => root.render(<View />));
    const event = { payload: { eventId: "one", goal: "检查条件", message: "已完成复查" } };
    receive(event); receive(event); expect(show).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    receive({ payload: { ...event.payload, eventId: "two" } }); expect(show).toHaveBeenCalledTimes(1);
    await act(async () => resolve(stop)); expect(stop).toHaveBeenCalledTimes(1);
  } finally { host.remove(); }
});
