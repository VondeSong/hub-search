import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useRef } from "react";
import {
  beginExternalOpen,
  externalLinkTarget,
  externalOpenSuccessMessage,
  finishExternalOpen,
  isCraftHttpsUrl,
  type ExternalOpenGate,
} from "./ExternalLinkOpening";
import type { OpenResultOutcome } from "./ResultOpening";
import { runtimeCapabilities } from "./RuntimePlatform";

type ExternalLinkStatus = (text: string, tone?: "working" | "success" | "error", duration?: number) => void;

type UseExternalLinkOpenerOptions = {
  showStatus?: ExternalLinkStatus;
  setError?: (message: string) => void;
};

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function useExternalLinkOpener({ showStatus, setError }: UseExternalLinkOpenerOptions) {
  const gate = useRef<ExternalOpenGate>({ pending: false, cooldownUntil: 0 });

  return useCallback(async (href: string): Promise<boolean> => {
    const normalizedHref = href.trim();
    const target = externalLinkTarget(normalizedHref);
    if (!target) {
      const message = "无法打开：仅支持 HTTPS、HTTP、Obsidian 或 Craft 链接";
      setError?.(message);
      showStatus?.(message, "error", 6_000);
      return false;
    }
    const startedAt = monotonicNow();
    if (!beginExternalOpen(gate.current, startedAt)) return false;
    showStatus?.(`正在交给${target.application}打开 · ${target.label}`, "working", 8_000);
    try {
      if (isCraftHttpsUrl(normalizedHref) && runtimeCapabilities.platform !== "android") {
        const outcome = await invoke<OpenResultOutcome>("open_craft_url", { url: normalizedHref });
        if (outcome.craftBridgeAction === "queued") {
          showStatus?.("Craft 正在准备页面，已排队等待打开 · Craft 网页链接", "working", 15_000);
          return true;
        }
        const message = outcome.craftBridgeAction === "activated"
          ? "已切换到 Craft"
          : outcome.craftBridgeAction === "updated"
            ? "已在 Craft 中定位"
            : "已在 Craft 中打开";
        showStatus?.(`${message} · Craft 网页链接`, "success", 4_200);
      } else {
        if (runtimeCapabilities.platform === "android") {
          await invoke("open_external_url", { url: normalizedHref });
        } else {
          await openUrl(normalizedHref);
        }
        showStatus?.(externalOpenSuccessMessage(target, monotonicNow() - startedAt), "success", 4_200);
      }
      return true;
    } catch (reason) {
      const message = `打开失败 · ${String(reason)}`;
      setError?.(message);
      showStatus?.(message, "error", 6_000);
      return false;
    } finally {
      finishExternalOpen(gate.current, monotonicNow());
    }
  }, [setError, showStatus]);
}
