import { LoaderCircle } from "lucide-react";
import { LibraryAddActions } from "./LibraryAddActions";
import type { LibraryAddOptions, LibraryContentOverrides } from "./LibraryManagement";

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;

type CraftConnectionSectionProps = {
  mobile?: boolean;
  mcpUrl: string;
  craftApiUrl: string;
  craftApiKey: string;
  connectingAction: ConnectingAction;
  connectionError: string;
  setMcpUrl: (value: string) => void;
  setCraftApiUrl: (value: string) => void;
  setCraftApiKey: (value: string) => void;
  contentPolicy?: LibraryContentOverrides;
  connect: (options?: LibraryAddOptions) => void | Promise<void>;
  saveCraftApiConnection: () => void | Promise<void>;
};

export function CraftConnectionSection({
  mobile = false,
  mcpUrl,
  craftApiUrl,
  craftApiKey,
  connectingAction,
  connectionError,
  setMcpUrl,
  setCraftApiUrl,
  setCraftApiKey,
  connect,
  contentPolicy,
  saveCraftApiConnection,
}: CraftConnectionSectionProps) {
  return (
    <>
      <h3 className="connection-section-title">连接 Craft 空间</h3>
      <label className="url-field"><span>MCP 地址</span><input value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.craft.do/links/…/mcp" spellCheck={false} /></label>
      {connectionError && <div className="connection-error">{connectionError}</div>}
      <LibraryAddActions busy={connectingAction !== null} contentPolicy={contentPolicy} onAdd={connect} label="授权并添加" busyLabel="等待 Craft 授权…" />
      <details className="connection-extra">
      <summary>API 连接<span>可选 · 任务图片与附件上传</span></summary>
      <div className="connection-extra-body">
      <label className="url-field"><span>API 地址（任务详情图片）</span><input type="password" value={craftApiUrl} onChange={(event) => setCraftApiUrl(event.target.value)} placeholder="https://connect.craft.do/links/…/api/v1" spellCheck={false} /></label>
      <label className="url-field"><span>API Key</span><input type="password" value={craftApiKey} onChange={(event) => setCraftApiKey(event.target.value)} placeholder="pdk_…（公开连接可留空）" spellCheck={false} /></label>
      <button className="connect-button" onClick={() => void saveCraftApiConnection()} disabled={connectingAction !== null || !craftApiUrl.trim()}>{connectingAction === "craft" ? <><LoaderCircle className="spin" size={18} />正在验证…</> : "验证并安全保存 API 连接"}</button>
      <div className="security-note">{mobile ? "API 地址和 Key 按空间加密保存在本机。可在 Craft → Imagine → API Connection 中创建连接。" : "API 地址和 Key 按 Craft 空间保存到系统凭据管理器，用于附件上传和子任务层级写入。Key 需在 Craft → Imagine → API Connection 中创建。"}</div>
      </div></details>
    </>
  );
}
