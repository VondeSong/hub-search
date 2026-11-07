import { LoaderCircle } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { LibraryAddActions } from "./LibraryAddActions";
import type { LibraryAddOptions, LibraryContentOverrides } from "./LibraryManagement";

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;

type FeishuKnowledgeSpace = {
  spaceId: string;
  name: string;
  description: string;
};

type FeishuAuthorizationSummary = {
  authorizationId: string;
  accountName?: string;
  spaces: FeishuKnowledgeSpace[];
};

type FeishuLibraryConnectionSectionProps = {
  mobile?: boolean;
  feishuAuthorization: FeishuAuthorizationSummary | null;
  feishuAppId: string;
  feishuAppSecret: string;
  selectedFeishuSpaceIds: string[];
  connectingAction: ConnectingAction;
  connectionError: string;
  setFeishuAuthorization: (authorization: FeishuAuthorizationSummary | null) => void;
  setFeishuAppId: (value: string) => void;
  setFeishuAppSecret: (value: string) => void;
  setSelectedFeishuSpaceIds: Dispatch<SetStateAction<string[]>>;
  connectFeishu: () => void | Promise<void>;
  contentPolicy?: LibraryContentOverrides;
  addSelectedFeishuSpaces: (options?: LibraryAddOptions) => void | Promise<void>;
};

export function FeishuLibraryConnectionSection({
  mobile = false,
  feishuAuthorization,
  feishuAppId,
  feishuAppSecret,
  selectedFeishuSpaceIds,
  connectingAction,
  connectionError,
  setFeishuAuthorization,
  setFeishuAppId,
  setFeishuAppSecret,
  setSelectedFeishuSpaceIds,
  connectFeishu,
  addSelectedFeishuSpaces,
  contentPolicy,
}: FeishuLibraryConnectionSectionProps) {
  return (
    <>
      <h3 className="connection-section-title">连接飞书资料库</h3>
      <p className="provider-connect-description">登录后可选择“我的文档”或一个或多个知识库，并同步其中的文档与多维表格记录。</p>
      {!feishuAuthorization ? <>
        <label className="url-field"><span>App ID</span><input value={feishuAppId} onChange={(event) => setFeishuAppId(event.target.value)} placeholder="cli_xxxxxxxxxxxxxxxx" spellCheck={false} /></label>
        <label className="url-field"><span>App Secret</span><input type="password" value={feishuAppSecret} onChange={(event) => setFeishuAppSecret(event.target.value)} placeholder="飞书开放平台应用密钥" spellCheck={false} autoComplete="off" /></label>
        <div className="security-note">请先在飞书开放平台把重定向 URL 登记为 <code>http://127.0.0.1:17653/oauth/callback</code>。Hub 会同时兼容浏览器的 IPv4/IPv6 本机回调。{!mobile && "App Secret 与刷新令牌只保存在 Windows 凭据管理器。"}</div>
        <button className="connect-button feishu-connect" onClick={() => void connectFeishu()} disabled={connectingAction !== null}>{connectingAction === "feishu" ? <><LoaderCircle className="spin" size={18} />等待飞书授权…</> : "登录并读取文档来源"}</button>
      </> : <div className="feishu-space-picker">
        <div className="feishu-space-picker-head">
          <span><strong>选择文档来源</strong><small>{feishuAuthorization.accountName ? `已登录：${feishuAuthorization.accountName}` : "飞书账号已授权"}</small></span>
          <button type="button" onClick={() => setSelectedFeishuSpaceIds(
            selectedFeishuSpaceIds.length === feishuAuthorization.spaces.length
              ? []
              : feishuAuthorization.spaces.map((space) => space.spaceId),
          )}>{selectedFeishuSpaceIds.length === feishuAuthorization.spaces.length ? "取消全选" : "全选"}</button>
        </div>
        {feishuAuthorization.spaces.length ? <div className="feishu-space-options">
          {feishuAuthorization.spaces.map((space) => {
            const checked = selectedFeishuSpaceIds.includes(space.spaceId);
            return <label key={space.spaceId} className={checked ? "selected" : ""}>
              <input type="checkbox" checked={checked} onChange={() => setSelectedFeishuSpaceIds((current) => checked
                ? current.filter((id) => id !== space.spaceId)
                : [...current, space.spaceId])} />
              <span><strong>{space.name}</strong>{space.description && <small>{space.description}</small>}</span>
            </label>;
          })}
        </div> : <div className="connection-error">当前账号没有返回可访问的文档来源。请确认应用已申请文档和知识空间读取权限。</div>}
        <div className="feishu-space-picker-actions">
          <button type="button" className="secondary-button" onClick={() => { setFeishuAuthorization(null); setSelectedFeishuSpaceIds([]); }}>重新登录</button>
          <LibraryAddActions busy={connectingAction !== null} disabled={selectedFeishuSpaceIds.length === 0} contentPolicy={contentPolicy} onAdd={addSelectedFeishuSpaces} label={`添加所选来源（${selectedFeishuSpaceIds.length}）`} />
        </div>
      </div>}
      {connectionError && <div className="connection-error feishu-connection-error">{connectionError}</div>}
    </>
  );
}
