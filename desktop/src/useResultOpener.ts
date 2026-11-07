import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef } from "react";
import { providerName } from "./ProviderLabels";
import {
  beginOpenAttempt,
  buildOpenResultRequest,
  finishOpenAttempt,
  type OpenAttemptGate,
  type OpenResultOutcome,
  type ResultOpenSettings,
  type ResultOpenSource,
  usesCraftBridge,
} from "./ResultOpening";
import type { SearchResult } from "./SearchTypes";
import { runtimeCapabilities } from "./RuntimePlatform";

type OperationTone = "working" | "success" | "error";

type UseResultOpenerOptions = {
  settings: ResultOpenSettings & { hideAfterOpen: boolean };
  showOperationStatus: (text: string, tone?: OperationTone, duration?: number) => void;
};

export function useResultOpener({
  settings,
  showOperationStatus,
}: UseResultOpenerOptions) {
  const guard = useRef<OpenAttemptGate>({ pending: false, cooldownUntil: 0 });

  return useCallback((result?: SearchResult, source: ResultOpenSource = "result") => {
    if (!result || !beginOpenAttempt(guard.current, Date.now())) return;

    const provider = providerName(result.provider);
    const title = result.title.length > 28 ? `${result.title.slice(0, 28)}…` : result.title;
    const openSettings = runtimeCapabilities.platform === "android"
      ? { ...settings, craftResultOpenMode: "web" as const, craftPreviewOpenMode: "web" as const, hideAfterOpen: false }
      : settings;
    const bridgeOpen = usesCraftBridge(result, source, openSettings);
    showOperationStatus(
      bridgeOpen ? `正在通过 CraftBridge 定位 Craft · ${title}` : `正在打开 ${provider} · ${title}`,
      "working",
      bridgeOpen ? 15000 : 4200,
    );

    void invoke<OpenResultOutcome>("open_result", buildOpenResultRequest(result, source, openSettings))
      .then(async (outcome) => {
        if (bridgeOpen && outcome?.craftBridgeAction === "queued") {
          showOperationStatus(`Craft 正在准备页面，已排队等待打开 · ${title}`, "working", 15000);
          return;
        }
        const bridgeMessage = outcome?.craftBridgeAction === "activated"
          ? "已切换到 Craft"
          : outcome?.craftBridgeAction === "updated"
            ? "已在 Craft 中定位"
            : outcome?.craftBridgeAction === "opened"
              ? "已在 Craft 中打开"
              : "已交给 Craft 打开";
        showOperationStatus(
          bridgeOpen ? `${bridgeMessage} · ${title}` : `已交给 ${provider} 打开 · ${title}`,
          "success",
        );
        if (!openSettings.hideAfterOpen || document.querySelector(".agent-panel:not([hidden])")) return;
        try {
          await invoke("hide_window");
        } catch (reason) {
          const message = `结果已打开，但隐藏窗口失败 · ${String(reason)}`;
          showOperationStatus(message, "error", 6000);
        }
      })
      .catch((reason) => {
        const message = String(reason);
        showOperationStatus(`打开失败 · ${message}`, "error", 6000);
      })
      .finally(() => finishOpenAttempt(guard.current, Date.now()));
  }, [settings, showOperationStatus]);
}
