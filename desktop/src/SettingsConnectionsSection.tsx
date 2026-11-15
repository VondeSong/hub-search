import type { ReactNode } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LibraryContentPolicyFields } from "./LibraryContentPolicyEditor";
import { INHERIT_LIBRARY_POLICY, type LibraryAddOptions, type LibraryContentOverrides, type LibraryContentPolicy, type LibraryPolicySnapshot } from "./LibraryManagement";
import { publishCodexNotice } from "./CodexSuite";
import { ChevronDown } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import type { Provider } from "./ProviderLabels";
import { CraftConnectionSection } from "./CraftConnectionSection";
import { DidaConnectionSection } from "./DidaConnectionSection";
import { FeishuBitableConnectionSection } from "./FeishuBitableConnectionSection";
import { FeishuLibraryConnectionSection } from "./FeishuLibraryConnectionSection";
import { ObsidianConnectionSection } from "./ObsidianConnectionSection";
import { LocalFilesConnectionSection } from "./LocalFilesConnectionSection";
import type { RuntimeCapabilities } from "./RuntimePlatform";
import type { LibrarySummary } from "./SearchTypes";

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;
type ConnectionErrorProvider = "craft" | "dida365" | "feishu" | "obsidian" | "general";

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

type SettingsConnectionsSectionProps = {
  runtimeCapabilities: RuntimeCapabilities;
  spaces: LibrarySummary[];
  feishuAuthorization: FeishuAuthorizationSummary | null;
  feishuAppId: string;
  feishuAppSecret: string;
  selectedFeishuSpaceIds: string[];
  feishuBitableSourceId: string;
  feishuBitableUrl: string;
  obsidianPath: string;
  mcpUrl: string;
  craftApiUrl: string;
  craftApiKey: string;
  connectingAction: ConnectingAction;
  connectionError: string;
  connectionErrorProvider: ConnectionErrorProvider;
  setFeishuAuthorization: (authorization: FeishuAuthorizationSummary | null) => void;
  setFeishuAppId: (value: string) => void;
  setFeishuAppSecret: (value: string) => void;
  setSelectedFeishuSpaceIds: Dispatch<SetStateAction<string[]>>;
  setFeishuBitableSourceId: (value: string) => void;
  setFeishuBitableUrl: (value: string) => void;
  setObsidianPath: (value: string) => void;
  setMcpUrl: (value: string) => void;
  setCraftApiUrl: (value: string) => void;
  setCraftApiKey: (value: string) => void;
  connectFeishu: () => void | Promise<void>;
  addSelectedFeishuSpaces: (options?: LibraryAddOptions) => void | Promise<void>;
  addFeishuBitable: (options?: LibraryAddOptions) => void | Promise<void>;
  connectDida365: (options?: LibraryAddOptions) => void | Promise<void>;
  addObsidian: (options?: LibraryAddOptions) => void | Promise<void>;
  connect: (options?: LibraryAddOptions) => void | Promise<void>;
  saveCraftApiConnection: () => void | Promise<void>;
};

export function SettingsConnectionsSection({
  runtimeCapabilities,
  spaces,
  feishuAuthorization,
  feishuAppId,
  feishuAppSecret,
  selectedFeishuSpaceIds,
  feishuBitableSourceId,
  feishuBitableUrl,
  obsidianPath,
  mcpUrl,
  craftApiUrl,
  craftApiKey,
  connectingAction,
  setFeishuAuthorization,
  setFeishuAppId,
  setFeishuAppSecret,
  setSelectedFeishuSpaceIds,
  setFeishuBitableSourceId,
  setFeishuBitableUrl,
  setObsidianPath,
  setMcpUrl,
  setCraftApiUrl,
  setCraftApiKey,
  connectFeishu,
  addSelectedFeishuSpaces,
  addFeishuBitable,
  connectDida365,
  addObsidian,
  connect,
  saveCraftApiConnection,
}: SettingsConnectionsSectionProps) {
  const [globalPolicy, setGlobalPolicy] = useState<LibraryContentPolicy>();
  const [policies, setPolicies] = useState<Record<Provider, LibraryContentOverrides>>({ craft: { ...INHERIT_LIBRARY_POLICY }, obsidian: { ...INHERIT_LIBRARY_POLICY }, dida365: { ...INHERIT_LIBRARY_POLICY }, feishu: { ...INHERIT_LIBRARY_POLICY }, files: { ...INHERIT_LIBRARY_POLICY } });
  useEffect(() => {
    let alive = true; let revision = 0;
    const read = () => { const current = ++revision; void invoke<LibraryPolicySnapshot>("library_content_policy", { args: { action: "get" } }).then(result => { if (alive && current === revision) setGlobalPolicy(result.global); }).catch(reason => { if (alive && current === revision) publishCodexNotice(`读取默认内容策略失败：${String(reason)}`, "error", 10000); }); };
    read(); window.addEventListener("hub:library-content-policy-changed", read);
    return () => { alive = false; window.removeEventListener("hub:library-content-policy-changed", read); };
  }, []);
  const policy = (provider: Provider) => <details className="library-add-policy"><summary>添加前选择内容策略</summary><p>正文始终保留。Craft、滴答自动保存附件原件；文字识别和写入附件可分别设置。</p><LibraryContentPolicyFields value={policies[provider]} global={globalPolicy} automaticOriginals={provider === "craft" || provider === "dida365"} capabilities={{ imageDownload: provider !== "feishu", imageOcr: provider !== "feishu" && runtimeCapabilities.nativeOcr, pdfDownload: provider !== "feishu", pdfText: provider !== "feishu", pdfOcr: provider !== "feishu" && runtimeCapabilities.nativeOcr, otherDownload: provider === "craft" || provider === "dida365", outgoingAttachments: provider !== "feishu" }} onChange={value => setPolicies(old => ({ ...old, [provider]: value }))} /></details>;
  const connectedFeishuSpaces = spaces.filter((space) => space.provider === "feishu" && space.connected && !space.location?.includes("/base/"));
  return (
    <div className="settings-connections settings-category libraries">
      <div className="settings-connections-heading"><h3>添加或重新连接资料库</h3><p>选择软件展开填写，已输入的内容会保留。</p></div>
      {runtimeCapabilities.localVault&&<LocalFilesConnectionSection blocked={connectingAction!==null}/>}
      <ConnectionGroup provider="feishu" label="飞书" description="文档、知识库与多维表格" busy={connectingAction === "feishu" || connectingAction === "feishuBitable"}>
      {policy("feishu")}
      <FeishuLibraryConnectionSection
        mobile={runtimeCapabilities.mobile}
        feishuAuthorization={feishuAuthorization}
        feishuAppId={feishuAppId}
        feishuAppSecret={feishuAppSecret}
        selectedFeishuSpaceIds={selectedFeishuSpaceIds}
        connectingAction={connectingAction}
        connectionError=""
        setFeishuAuthorization={setFeishuAuthorization}
        setFeishuAppId={setFeishuAppId}
        setFeishuAppSecret={setFeishuAppSecret}
        setSelectedFeishuSpaceIds={setSelectedFeishuSpaceIds}
        connectFeishu={connectFeishu}
        addSelectedFeishuSpaces={addSelectedFeishuSpaces}
        contentPolicy={policies.feishu}
      />
      <div className="security-note">Hub 仅调用飞书文档 MCP 的只读工具和多维表格只读 API，不会创建或修改飞书内容。新增多维表格权限后需要重新登录授权。</div>
      <FeishuBitableConnectionSection
        connectedFeishuSpaces={connectedFeishuSpaces}
        feishuBitableSourceId={feishuBitableSourceId}
        feishuBitableUrl={feishuBitableUrl}
        connectingAction={connectingAction}
        setFeishuBitableSourceId={setFeishuBitableSourceId}
        setFeishuBitableUrl={setFeishuBitableUrl}
        addFeishuBitable={addFeishuBitable}
        contentPolicy={policies.feishu}
      />
      </ConnectionGroup>
      <ConnectionGroup provider="dida365" label="滴答清单" description="项目、任务与检查项" busy={connectingAction === "dida365"}>
      {policy("dida365")}
      <DidaConnectionSection
        mobile={runtimeCapabilities.mobile}
        connectingAction={connectingAction}
        connectionError=""
        connectDida365={connectDida365}
        contentPolicy={policies.dida365}
      />
      </ConnectionGroup>
      {runtimeCapabilities.localVault && <ConnectionGroup provider="obsidian" label="Obsidian" description="本地 Markdown 资料库" busy={connectingAction === "obsidian"}>
      {policy("obsidian")}
      <ObsidianConnectionSection
        obsidianPath={obsidianPath}
        connectingAction={connectingAction}
        connectionError=""
        setObsidianPath={setObsidianPath}
        addObsidian={addObsidian}
        contentPolicy={policies.obsidian}
      /></ConnectionGroup>}
      <ConnectionGroup provider="craft" label="Craft" description="空间页面与附件" busy={connectingAction === "craft"}>
      {policy("craft")}
      <CraftConnectionSection
        mobile={runtimeCapabilities.mobile}
        mcpUrl={mcpUrl}
        craftApiUrl={craftApiUrl}
        craftApiKey={craftApiKey}
        connectingAction={connectingAction}
        connectionError=""
        setMcpUrl={setMcpUrl}
        setCraftApiUrl={setCraftApiUrl}
        setCraftApiKey={setCraftApiKey}
        connect={connect}
        saveCraftApiConnection={saveCraftApiConnection}
        contentPolicy={policies.craft}
      />
      </ConnectionGroup>
    </div>
  );
}

function ConnectionGroup({ provider, label, description, busy, children }: { provider: Provider; label: string; description: string; busy: boolean; children: ReactNode }) {
  return <details className="provider-connection-card" name="settings-library-connections" data-provider={provider}>
    <summary>
      <LibraryIcon provider={provider} name={label} />
      <span className="provider-connection-heading"><strong>{label}</strong><small>{description}</small></span>
      <span className="provider-connection-action">{busy ? "正在连接…" : provider === "obsidian" ? "添加资料库" : "添加 / 重新授权"}</span>
      <ChevronDown className="provider-connection-chevron" size={18} aria-hidden="true" />
    </summary>
    <div className="provider-connection-body">{children}</div>
  </details>;
}
