// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  CloudSyncSettingsSection,
  type CloudSyncPolicy,
} from "./CloudSyncSettingsSection";
import type { Transfers } from "./CloudAttachmentPolicies";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root,
  host: HTMLDivElement,
  policy: CloudSyncPolicy,
  transfers: Transfers;
const click = async (text: string) =>
  act(async () => {
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .click();
  });
const load = async () =>
  act(async () => {
    root.render(<CloudSyncSettingsSection />);
  });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  policy = { enabled: true, autoSync: false, flashcards: true, reading: true };
  const p = { image: true, video: false, pdf: true, other: false, maxMb: 20 };
  transfers = Object.fromEntries(
    ["flashcards", "reading", "quick"].map((m) => [
      m,
      { upload: { ...p }, download: { ...p } },
    ]),
  ) as Transfers;
  invoke.mockReset();
  invoke.mockImplementation(async (command, args) => {
    if (command === "get_cloud_sync_policy") return { ...policy };
    if (command === "get_cloud_attachment_policies") return transfers;
    if (command === "update_cloud_sync_policy") {
      policy = args.settings;
      return policy;
    }
    if (command === "update_cloud_attachment_policy") {
      transfers = { ...transfers, [args.module]: args.settings };
      return args.settings;
    }
    if (command === "get_quick_journal_settings")
      return {
        settings: {
          libraryId: "os",
          folder: "Daily",
          sync: true,
          dateFolders: true,
        },
        supported: true,
        error: "",
        report: { pendingUpload: 2, awaitingOs: 1, written: 8 },
      };
    if (command === "get_flashcard_sync_settings")
      return { url: "", username: "", configured: true, lastError: "" };
    if (command === "get_reading_sync_status")
      return { supported: true, running: false, lastError: "", report: null };
    if (
      command === "list_flashcard_sync_history" ||
      command === "list_libraries"
    )
      return [];
    if (command === "get_flashcard_cloud_sync_settings")
      return {
        provider: "oss",
        oss: {
          bucket: "existing",
          region: "cn-hangzhou",
          prefix: "hub",
          accessKeyId: "example",
        },
        hasSecret: true,
        mediaPolicy: "all",
      };
    if (command === "get_flashcard_cloud_sync_report") return null;
    if (command === "get_reading_network_policy")
      return { mode: "any", allowed: true, network: { connected: true } };
    if (command === "get_reading_cache_status")
      return { bytes: 0, pinnedBytes: 0, pins: [] };
    if (command === "get_reading_source_cleanup") return false;
    if (command.startsWith("sync_")) return {};
    return undefined;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("keeps normal overview compact with one action and runs enabled modules despite partial failure", async () => {
  await load();
  expect(host.textContent).toContain("阿里云 OSS");
  expect(host.textContent).not.toContain("上传到云端");
  expect(
    [...host.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("立即同步"),
    ),
  ).toHaveLength(1);
  const fallback = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (c, a) => {
    if (c === "sync_flashcards") throw Error("附件失败");
    return fallback(c, a);
  });
  await click("立即同步");
  expect(
    invoke.mock.calls
      .filter(([c]) =>
        ["sync_flashcards", "sync_reading", "sync_quick_journal"].includes(c),
      )
      .map(([c]) => c),
  ).toEqual(["sync_flashcards", "sync_reading", "sync_quick_journal"]);
  expect(host.querySelector("[role=alert]")?.textContent).toContain("附件失败");
});
it("saves per-module upload choices without changing download or other module policy", async () => {
  await load();
  await click("同步设置");
  const prior = structuredClone(transfers);
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="阅读上传视频"]',
  )!;
  await act(async () => input.click());
  expect(transfers.reading.upload.video).toBe(true);
  expect(transfers.reading.download).toEqual(prior.reading.download);
  expect(transfers.flashcards).toEqual(prior.flashcards);
  expect(transfers.quick).toEqual(prior.quick);
  expect(host.textContent).not.toMatch(/每轮.*额度|每日.*额度/);
});
it("pausing preserves module choices and blocks the global sync action", async () => {
  await load();
  await click("暂停此设备");
  expect(policy).toEqual({
    enabled: false,
    autoSync: false,
    flashcards: true,
    reading: true,
  });
  expect(
    [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("立即同步"),
    )!.disabled,
  ).toBe(true);
});
it("does not poll when the cloud panel is inactive", async () => {
  vi.useFakeTimers();
  try {
    await act(async () =>
      root.render(<CloudSyncSettingsSection active={false} />),
    );
    const before = invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(invoke.mock.calls).toHaveLength(before);
  } finally {
    vi.useRealTimers();
  }
});
it("refreshes all module results after automatic recovery and clears only the sync failure", async () => {
  vi.useFakeTimers();
  try {
    let offline = true;
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === "get_flashcard_sync_settings")
        return {
          configured: true,
          url: "",
          username: "",
          lastError: offline ? "网络不可用" : "",
          lastSyncAt: offline ? 0 : 100,
        };
      if (command === "sync_flashcards") throw Error("网络不可用");
      return fallback(command, args);
    });
    await load();
    await click("立即同步");
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "网络不可用",
    );
    const manualCalls = invoke.mock.calls.filter(([c]) =>
      c.startsWith("sync_"),
    ).length;
    offline = false;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(
      host.querySelector(".cloud-module-results")?.textContent,
    ).not.toContain("网络不可用");
    expect(
      invoke.mock.calls.filter(([c]) => c.startsWith("sync_")),
    ).toHaveLength(manualCalls);
    await click("同步设置");
    invoke.mockImplementation(async (command, args) => {
      if (command === "update_cloud_sync_policy") throw Error("设置保存失败");
      return fallback(command, args);
    });
    await act(async () =>
      host.querySelector<HTMLInputElement>('[aria-label="同步阅读"]')!.click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "设置保存失败",
    );
  } finally {
    vi.useRealTimers();
  }
});
it("does not let an older poll overwrite the result of a newer manual sync", async () => {
  vi.useFakeTimers();
  try {
    const fallback = invoke.getMockImplementation()!;
    let deferPoll = false;
    let resolvePoll: ((value: unknown) => void) | undefined;
    invoke.mockImplementation(async (command, args) => {
      if (command === "get_flashcard_sync_settings" && deferPoll) {
        deferPoll = false;
        return new Promise((resolve) => { resolvePoll = resolve; });
      }
      return fallback(command, args);
    });
    await load();
    deferPoll = true;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(resolvePoll).toBeDefined();
    await click("立即同步");
    await act(async () => resolvePoll!({ configured: true, lastError: "过期的网络错误" }));
    expect(host.querySelector(".cloud-module-results")?.textContent).not.toContain(
      "过期的网络错误",
    );
    expect(host.querySelector(".cloud-overview-status h3")?.textContent).toBe("云同步");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps attachment failures visible only while their module participates", async () => {
  const fallback = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) =>
    command === "get_reading_sync_status"
      ? {
          supported: true,
          running: false,
          lastError: "",
          report: { pending: 0, completedAt: 100, media: { failed: 2 } },
        }
      : fallback(command, args),
  );
  await load();
  expect(host.querySelector(".cloud-overview-status h3")?.textContent).toBe(
    "有项目需要处理",
  );
  expect(host.querySelector(".cloud-module-results")?.textContent).toContain(
    "2 个附件未完成",
  );
  await click("同步设置");
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="同步阅读"]')!.click(),
  );
  await click("概览");
  expect(host.querySelector(".cloud-overview-status h3")?.textContent).toBe(
    "云同步",
  );
});
it("preserves an unsaved connection form across navigation", async () => {
  await load();
  await click("云连接");
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="阿里云 OSS 配置"] input',
  )!;
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    set.call(input, "draft-bucket");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("概览");
  await click("云连接");
  expect(
    host.querySelector<HTMLInputElement>(
      '[aria-label="阿里云 OSS 配置"] input',
    )!.value,
  ).toBe("draft-bucket");
});
