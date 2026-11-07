import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { LibraryAddActions } from "./LibraryAddActions";
import type { LibraryAddOptions, LibraryContentOverrides } from "./LibraryManagement";
import { publishCodexNotice } from "./CodexSuite";

type DidaAttachmentSessionStatus = {
  connected: boolean;
  cookieCount: number;
  message: string;
};

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;

type DidaConnectionSectionProps = {
  mobile?: boolean;
  connectingAction: ConnectingAction;
  connectionError: string;
  contentPolicy?: LibraryContentOverrides;
  connectDida365: (options?: LibraryAddOptions) => void | Promise<void>;
};

export function DidaConnectionSection({
  mobile = false,
  connectingAction,
  connectionError,
  connectDida365,
  contentPolicy,
}: DidaConnectionSectionProps) {
  const [attachmentSession, setAttachmentSession] = useState<DidaAttachmentSessionStatus>();
  const [attachmentAction, setAttachmentAction] = useState<"login" | "check" | null>(null);

  const checkAttachmentSession = async () => {
    setAttachmentAction("check");
    try {
      setAttachmentSession(await invoke<DidaAttachmentSessionStatus>("get_dida_attachment_session_status"));
    } catch (reason) {
      publishCodexNotice(String(reason), "error", 10000);
    } finally {
      setAttachmentAction(null);
    }
  };

  const openAttachmentLogin = async () => {
    setAttachmentAction("login");
    try {
      await invoke("open_dida_attachment_login");
    } catch (reason) {
      publishCodexNotice(String(reason), "error", 10000);
    } finally {
      setAttachmentAction(null);
    }
  };

  return (
    <>
      <h3 className="connection-section-title">连接滴答账号</h3>
      <p className="provider-connect-description">通过滴答清单官方 MCP 登录，只读取项目、任务和检查项，并缓存到本地搜索索引。</p>
      <LibraryAddActions busy={connectingAction !== null} contentPolicy={contentPolicy} onAdd={connectDida365} label="登录并添加" busyLabel="等待滴答清单授权…" />
      {connectionError && <div className="connection-error">{connectionError}</div>}
      <div className="security-note">资料库同步只读取项目、任务和检查项。收藏保存与任务转换会按你选择的目标清单写入。</div>
      {!mobile && <details className="connection-extra">
      <summary>附件登录<span>可选 · 图片、视频与附件同步</span></summary>
      <div className="connection-extra-body">
      <p className="provider-connect-description">附件不在官方 MCP/Open API 中，需要在 Hub 的独立滴答窗口登录。会话保留在系统 WebView Cookie 存储中，用于预览下载，以及将 Craft 任务图片上传为滴答附件。</p>
      <button className="connect-button dida-connect" onClick={() => void openAttachmentLogin()} disabled={attachmentAction !== null}>
        {attachmentAction === "login" ? <><LoaderCircle className="spin" size={18} />正在打开登录窗口…</> : "打开或重新加载滴答附件登录"}
      </button>
      <button className="connect-button secondary" onClick={() => void checkAttachmentSession()} disabled={attachmentAction !== null}>
        {attachmentAction === "check" ? <><LoaderCircle className="spin" size={18} />正在检查…</> : "检查附件登录状态"}
      </button>
      {attachmentSession && <div className={attachmentSession.connected ? "security-note" : "connection-error"}>{attachmentSession.message}</div>}
      <div className="security-note">附件通道只读取任务附件，并在同步 Craft 任务时上传对应附件；不会读取 Chrome Cookie，也不会把 Cookie 写入 Hub 数据库。</div>
      </div></details>}
    </>
  );
}
