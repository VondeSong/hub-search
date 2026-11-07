import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Scope = { libraryId: string; documentId: string };
type Result = { success: boolean; failureCode?: string; metadataBytes?: number; rounds?: unknown[]; attachmentGets?: number; attachmentBytes?: number; originalDownloadAllowed?: boolean; cacheRevalidationAllowed?: boolean; originalVersionsVerified?: boolean; credentialRefreshed?: boolean; personalDataWritten?: boolean;
  diagnostics?: { version?: number; round?: number; phase?: string; completedRounds?: number; requests?: { outcome?: string; httpStatus?: number }[] } };
const phases: Record<string, string> = { preflight: "检查本地条件", credential: "检查授权", connect: "连接服务", fetchPage: "读取页面", persistPage: "保存隔离页面", discoverAttachments: "核对附件清单", scheduleAttachments: "准备附件核验", verifyAttachment: "核验附件", verifyOriginals: "检查原件", verifyBinding: "检查版本绑定" };
function interruptionDetail(result: Result | null): string | null {
  const d = result?.diagnostics;
  if (result?.success !== false || d?.version !== 1 || !Number.isInteger(d.round) || d.round! < 0 || d.round! > 2
    || !Number.isInteger(d.completedRounds) || d.completedRounds! < 0 || d.completedRounds! > 2 || !Object.prototype.hasOwnProperty.call(phases, d.phase || "")) return null;
  const request = Array.isArray(d.requests) ? d.requests[d.requests.length - 1] : undefined;
  const remote = ["connect", "fetchPage"].includes(d.phase!);
  const cause = remote && request?.outcome === "httpError" && Number.isInteger(request.httpStatus) && request.httpStatus! >= 400 && request.httpStatus! <= 599
    ? `服务返回 HTTP ${request.httpStatus}。` : remote && request?.outcome === "timeout" ? "请求等待超时。"
    : remote && request?.outcome === "responseParse" ? "服务响应无法解析。"
    : remote && request?.outcome === "rpcError" ? "服务返回调用错误。"
    : remote && request?.outcome === "toolError" ? "服务未能返回所需结果。" : "";
  return `已完成 ${d.completedRounds}/2 轮；停在${d.round ? `第 ${d.round} 轮` : "开始前"}的“${phases[d.phase!]}”。${cause}`;
}

/** Normal profiles only read status. A CLI-bound isolated scope may run one read-only probe. */
export default function IsolatedRuntimeProbe() {
  const [scope, setScope] = useState<Scope | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [originals, setOriginals] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    void invoke<{ enabled: boolean; craftProbeCredentialScope?: Scope | null }>("get_isolated_runtime_status")
      .then(async (status) => {
        if (active && status.enabled === true) {
          await invoke("record_isolated_frontend_ready");
          if (active && status.craftProbeCredentialScope) setScope(status.craftProbeCredentialScope);
        }
      })
      .catch(() => {
        // The package smoke check reads a backend receipt; absence remains a failed check.
        if (active) console.warn("隔离启动联调回执未完成");
      });
    return () => { active = false; };
  }, []);
  if (!scope) return null;
  const transferVerified = originals ? result?.originalDownloadAllowed === true && result.originalVersionsVerified === true
    && Number.isInteger(result.attachmentGets) && result.attachmentGets! >= 0 && result.attachmentGets! <= 3
    && Number.isInteger(result.attachmentBytes) && result.attachmentBytes! >= 0 && result.attachmentBytes! <= 3 * 1024 * 1024
    : result?.attachmentGets === 0;
  const passed = result?.success === true && transferVerified && (!revalidating || result.cacheRevalidationAllowed === true)
    && result.credentialRefreshed === false && result.personalDataWritten === false && result.rounds?.length === 2;
  const run = async (withOriginals = false, revalidate = false) => {
    if (started.current) return;
    started.current = true; setOriginals(withOriginals); setRevalidating(revalidate); setBusy(true);
    try {
      setResult(await invoke<Result>("verify_isolated_craft_cache", revalidate ? { ...scope, revalidateOriginals: true } : withOriginals ? { ...scope, allowOriginalDownload: true } : scope));
    } catch {
      setResult({ success: false, failureCode: "PROBE_OPERATION_FAILED" });
    } finally { setBusy(false); }
  };
  return <aside aria-label="单页只读服务验证" style={{ position: "fixed", zIndex: 10000, top: 16, right: 16,
    maxWidth: 370, padding: 16, background: "Canvas", color: "CanvasText", border: "1px solid GrayText", borderRadius: 12 }}>
    <strong>单页只读服务验证 · 隔离运行</strong>
    <p>仅核对已绑定的一个 Craft 页面及已有附件缓存；最多两轮，不刷新凭据，不写入真实资料。</p>
    <p style={{ overflowWrap: "anywhere" }}>页面：{scope.documentId}</p>
    <button type="button" disabled={busy || started.current} onClick={() => void run()}>核对这个页面的缓存</button>
    <button type="button" disabled={busy || started.current} onClick={() => void run(true)}>核对页面与当前原件（最多 3 MB）</button>
    <button type="button" disabled={busy || started.current} onClick={() => void run(true, true)}>核验版本并复用附件（最多 3 MB）</button>
    <p role="status">{busy ? "正在核对指定页面…" : result ? passed ? originals
      ? `两轮只读核对通过；当前原件版本已核验，读取附件 ${result.attachmentGets} 次、${result.attachmentBytes} 字节；未刷新凭据、未写入真实资料。`
      : "两轮只读核对通过；未下载附件、未刷新凭据、未写入真实资料。"
      : `核对未通过：${/^PROBE_[A-Z_]+$/.test(result.failureCode || "") ? result.failureCode : "PROBE_INCOMPLETE_RESULT"}` : "尚未开始。"}</p>
    {result && <small>本次读取元数据：{Number.isFinite(result.metadataBytes) ? result.metadataBytes : "未知"} 字节。</small>}
    {interruptionDetail(result) && <p>{interruptionDetail(result)}</p>}
  </aside>;
}
