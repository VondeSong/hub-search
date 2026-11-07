// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import IsolatedRuntimeProbe from "./IsolatedRuntimeProbe";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const scope = { libraryId: "one-library", documentId: "one-document" };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
const render = () => act(async () => root.render(<IsolatedRuntimeProbe />));
it("does not expose a service probe in a normal profile even if a scope is present", async () => {
  invoke.mockResolvedValue({ enabled: false, craftProbeCredentialScope: scope });
  await render(); expect(host.textContent).toBe("");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_isolated_runtime_status"]);
});
it("records isolated startup without enabling any service scope by default", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true } : undefined);
  await render(); expect(host.textContent).toBe("");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_isolated_runtime_status", "record_isolated_frontend_ready"]);
});
it("waits for an explicit click and invokes only the host-bound page once", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: true, attachmentGets: 0, credentialRefreshed: false, personalDataWritten: false, rounds: [{}, {}], metadataBytes: 1234 } : undefined);
  await render(); expect(host.textContent).toContain(scope.documentId);
  expect(invoke.mock.calls.some(([command]) => command === "verify_isolated_craft_cache")).toBe(false);
  await act(async () => host.querySelector("button")!.click());
  await act(async () => host.querySelector("button")!.click());
  expect(invoke.mock.calls.filter(([command]) => command === "verify_isolated_craft_cache")).toEqual([["verify_isolated_craft_cache", scope]]);
  expect(host.textContent).toContain("两轮只读核对通过"); expect(host.textContent).toContain("1234 字节");
});
it("keeps an expired credential failure terminal and does not retry or refresh it", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: false, failureCode: "PROBE_AUTH_NOT_FRESH", metadataBytes: 0 } : undefined);
  await render(); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("PROBE_AUTH_NOT_FRESH"); expect(host.querySelector("button")!.disabled).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === "verify_isolated_craft_cache")).toHaveLength(1);
});
it("requires complete receipts and never displays an arbitrary error payload", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: true, failureCode: "secret-valued-url", rounds: [] } : undefined);
  await render(); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("PROBE_INCOMPLETE_RESULT"); expect(host.textContent).not.toContain("secret-valued-url");
});
it("only allows bounded original reads after the distinct explicit click and a complete proof", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: true, attachmentGets: 1, attachmentBytes: 143248, originalDownloadAllowed: true, originalVersionsVerified: true, credentialRefreshed: false, personalDataWritten: false, rounds: [{}, {}] } : undefined);
  await render(); await act(async () => host.querySelectorAll("button")[1].click());
  expect(invoke.mock.calls.filter(([c]) => c === "verify_isolated_craft_cache")).toEqual([["verify_isolated_craft_cache", { ...scope, allowOriginalDownload: true }]]);
  expect(host.textContent).toContain("当前原件版本已核验"); expect(host.textContent).toContain("143248 字节");
  expect(host.textContent).not.toContain("未下载附件");
});
it.each([{ attachmentBytes: 4 * 1024 * 1024, originalVersionsVerified: true }, { attachmentBytes: 100, originalVersionsVerified: false }])("rejects incomplete or over-budget original receipts %o", async overrides => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: true, attachmentGets: 1, originalDownloadAllowed: true, credentialRefreshed: false, personalDataWritten: false, rounds: [{}, {}], ...overrides } : undefined);
  await render(); await act(async () => host.querySelectorAll("button")[1].click());
  expect(host.textContent).toContain("PROBE_INCOMPLETE_RESULT"); expect(host.textContent).not.toContain("核对通过");
});
it.each([true, false])("keeps cache revalidation explicit and requires its native receipt: %s", async allowed => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: true, attachmentGets: 2, attachmentBytes: 0, originalDownloadAllowed: true, cacheRevalidationAllowed: allowed, originalVersionsVerified: true, credentialRefreshed: false, personalDataWritten: false, rounds: [{}, {}] } : undefined);
  await render(); await act(async () => host.querySelectorAll("button")[2].click());
  expect(invoke.mock.calls.filter(([c]) => c === "verify_isolated_craft_cache")).toEqual([["verify_isolated_craft_cache", { ...scope, revalidateOriginals: true }]]);
  expect(host.textContent).toContain(allowed ? "当前原件版本已核验" : "PROBE_INCOMPLETE_RESULT");
  expect(host.textContent).not.toContain("未下载附件");
});
it("shows the completed round and safe request cause without replaying a failed service check", async () => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: false, failureCode: "PROBE_OPERATION_FAILED", diagnostics: {
      version: 1, round: 2, completedRounds: 1, phase: "fetchPage", requests: [{ outcome: "httpError", httpStatus: 502, response: "secret payload" }] } } : undefined);
  await render(); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("已完成 1/2 轮"); expect(host.textContent).toContain("第 2 轮"); expect(host.textContent).toContain("读取页面");
  expect(host.textContent).toContain("HTTP 502"); expect(host.textContent).not.toContain("secret payload");
  expect(invoke.mock.calls.filter(([c]) => c === "verify_isolated_craft_cache")).toHaveLength(1);
});
it.each(["private-phase", "__proto__"])("does not render an unknown diagnostic phase: %s", async phase => {
  invoke.mockImplementation(async command => command === "get_isolated_runtime_status" ? { enabled: true, craftProbeCredentialScope: scope }
    : command === "verify_isolated_craft_cache" ? { success: false, failureCode: "PROBE_OPERATION_FAILED", diagnostics: {
      version: 1, round: 2, completedRounds: 1, phase, requests: [{ outcome: "private-error", httpStatus: "private-status" }] } } : undefined);
  await render(); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).not.toContain(phase); expect(host.textContent).not.toContain("private-error"); expect(host.textContent).not.toContain("private-status");
});
