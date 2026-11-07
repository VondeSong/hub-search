import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LibraryAddOptions, useLibraryManagement } from "./LibraryManagement";
import type { LibrarySummary } from "./SearchTypes";
import type { showOperationStatus } from "./useOperationStatus";

export type ToolSummary = { name: string; description: string; inputs: string[] };
export type ConnectionSummary = { spaceId: string; spaceName: string; serverName: string; serverVersion: string; tools: ToolSummary[]; canOpenCraft: boolean };
export type FeishuKnowledgeSpace = { spaceId: string; name: string; description: string };
export type FeishuAuthorizationSummary = { authorizationId: string; accountName?: string; spaces: FeishuKnowledgeSpace[] };
export type SyncSummary = { indexed: number; skipped: number; deleted: number; failed: number };
export type ConnectionErrorProvider = "craft" | "dida365" | "feishu" | "obsidian" | "general";
type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;
type Options = {
  spaces: LibrarySummary[];
  ready: boolean;
  registryError: string;
  reloadSpaces: () => Promise<LibrarySummary[]>;
  refreshStatus: () => Promise<unknown>;
  libraryManagement: ReturnType<typeof useLibraryManagement>;
  selectOnlyLibrary: (id: string) => void;
  selectLibraries: (ids: string[]) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  showOperationStatus: typeof showOperationStatus;
};

export function useLibraryConnections({ spaces,ready,registryError,reloadSpaces,refreshStatus,libraryManagement,selectOnlyLibrary,selectLibraries,searchInput,showOperationStatus }: Options) {
  const [mcpUrl,setMcpUrl] = useState(import.meta.env.VITE_CRAFT_MCP_URL ?? "");
  const [craftApiUrl,setCraftApiUrl] = useState("");
  const [craftApiKey,setCraftApiKey] = useState("");
  const [obsidianPath,setObsidianPath] = useState("");
  const [connectingAction,setConnectingAction] = useState<ConnectingAction>(null);
  const [connectionError,setConnectionError] = useState("");
  const [connectionErrorProvider,setConnectionErrorProvider] = useState<ConnectionErrorProvider>("general");
  const [feishuAppId,setFeishuAppId] = useState("");
  const [feishuAppSecret,setFeishuAppSecret] = useState("");
  const [feishuAuthorization,setFeishuAuthorization] = useState<FeishuAuthorizationSummary | null>(null);
  const [selectedFeishuSpaceIds,setSelectedFeishuSpaceIds] = useState<string[]>([]);
  const [feishuBitableUrl,setFeishuBitableUrl] = useState("");
  const [feishuBitableSourceId,setFeishuBitableSourceId] = useState("");
  const active = useRef(true), running = useRef(false), focusTimer = useRef<number | undefined>(undefined);
  const autoConnectStarted = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; window.clearTimeout(focusTimer.current); }; }, []);
  const focusSearch = useCallback(() => {
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => { if (active.current && !document.querySelector('[role="dialog"]')) searchInput.current?.focus(); }, 50);
  }, [searchInput]);

const connect = useCallback(async (initOptions?: LibraryAddOptions) => {
    if (running.current || !active.current) return;
    setConnectionErrorProvider("craft");
    if (!mcpUrl.trim()) {
      setConnectionError("请输入 Craft MCP 地址");
      return;
    }
    running.current = true;
    setConnectingAction("craft");
    setConnectionError("");
    try {
      const summary = await invoke<ConnectionSummary>("connect_mcp", { mcpUrl: mcpUrl.trim(), initOptions });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      selectOnlyLibrary(summary.spaceId);
      setMcpUrl("");
      focusSearch();
      await libraryManagement.refresh();
      if (!active.current) return;
      showOperationStatus(initOptions?.startNow === false ? "资料库已添加并暂停，可稍后继续" : "资料库已添加，后台开始处理", "success");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, mcpUrl, reloadSpaces, libraryManagement.refresh, showOperationStatus]);

const saveCraftApiConnection = useCallback(async () => {
    if (running.current || !active.current) return;
    setConnectionErrorProvider("craft");
    if (!craftApiUrl.trim()) {
      setConnectionError("请输入 Craft API 地址");
      return;
    }
    running.current = true;
    setConnectingAction("craft");
    setConnectionError("");
    try {
      const summary = await invoke<{ spaceId: string; spaceName: string }>("set_craft_api_connection", {
        apiUrl: craftApiUrl.trim(),
        apiKey: craftApiKey.trim(),
      });
      if (!active.current) return;
      setCraftApiUrl("");
      setCraftApiKey("");
      showOperationStatus(`已安全保存 Craft API 连接 · ${summary.spaceName}`, "success");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, craftApiKey, craftApiUrl, showOperationStatus]);

const connectDida365 = useCallback(async (initOptions?: LibraryAddOptions) => {
    if (running.current || !active.current) return;
    setConnectionErrorProvider("dida365");
    running.current = true;
    setConnectingAction("dida365");
    setConnectionError("");
    try {
      const summary = await invoke<ConnectionSummary>("connect_dida365", { initOptions });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      selectOnlyLibrary(summary.spaceId);
      focusSearch();
      await libraryManagement.refresh();
      if (!active.current) return;
      showOperationStatus(initOptions?.startNow === false ? "资料库已添加并暂停，可稍后继续" : "资料库已添加，后台开始处理", "success");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, reloadSpaces, libraryManagement.refresh, showOperationStatus]);

const connectFeishu = useCallback(async () => {
    if (running.current || !active.current) return;
    setConnectionErrorProvider("feishu");
    if (!feishuAppId.trim() || !feishuAppSecret.trim()) {
      setConnectionError("请填写 App ID 和 App Secret");
      return;
    }
    running.current = true;
    setConnectingAction("feishu");
    setConnectionError("");
    try {
      const summary = await invoke<FeishuAuthorizationSummary>("connect_feishu", {
        appId: feishuAppId.trim(),
        appSecret: feishuAppSecret.trim(),
      });
      if (!active.current) return;
      setFeishuAuthorization(summary);
      setSelectedFeishuSpaceIds(summary.spaces.some((space) => space.spaceId === "my_library") ? ["my_library"] : []);
      setFeishuAppSecret("");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, feishuAppId, feishuAppSecret]);

const addSelectedFeishuSpaces = useCallback(async (initOptions?: LibraryAddOptions) => {
    if (running.current || !active.current) return;
    if (!feishuAuthorization || selectedFeishuSpaceIds.length === 0) {
      setConnectionErrorProvider("feishu");
      setConnectionError("请至少选择一个飞书文档来源");
      return;
    }
    setConnectionErrorProvider("feishu");
    running.current = true;
    setConnectingAction("feishu");
    setConnectionError("");
    try {
      const summaries = await invoke<ConnectionSummary[]>("add_feishu_spaces", {
        authorizationId: feishuAuthorization.authorizationId,
        spaceIds: selectedFeishuSpaceIds,
        initOptions,
      });
      if (!active.current) return;
      selectLibraries(summaries.map((summary) => summary.spaceId));
      await reloadSpaces();
      if (!active.current) return;
      await libraryManagement.refresh();
      if (!active.current) return;
      setFeishuAuthorization(null);
      setSelectedFeishuSpaceIds([]);
      showOperationStatus(initOptions?.startNow === false ? "所选资料库已添加并暂停" : "所选资料库已添加，后台分别处理", "success");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, feishuAuthorization, reloadSpaces, selectedFeishuSpaceIds, libraryManagement.refresh, showOperationStatus]);

const addFeishuBitable = useCallback(async (initOptions?: LibraryAddOptions) => {
    if (running.current || !active.current) return;
    const sourceLibraryId = feishuBitableSourceId
      || spaces.find((space) => space.provider === "feishu" && space.connected)?.id
      || "";
    setConnectionErrorProvider("feishu");
    if (!sourceLibraryId) {
      setConnectionError("请先登录并添加一个飞书资料库，再使用该账号读取多维表格");
      return;
    }
    if (!feishuBitableUrl.trim()) {
      setConnectionError("请粘贴包含 table 参数的飞书多维表格链接");
      return;
    }
    running.current = true;
    setConnectingAction("feishuBitable");
    setConnectionError("");
    try {
      const summary = await invoke<ConnectionSummary>("add_feishu_bitable", {
        sourceLibraryId,
        url: feishuBitableUrl.trim(),
        initOptions,
      });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      await libraryManagement.refresh();
      if (!active.current) return;
      selectOnlyLibrary(summary.spaceId);
      setFeishuBitableUrl("");
      showOperationStatus(initOptions?.startNow === false ? "多维表格已添加并暂停" : "多维表格已添加，后台开始处理", "success");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, feishuBitableSourceId, feishuBitableUrl, reloadSpaces, spaces, libraryManagement.refresh, showOperationStatus]);

const addObsidian = useCallback(async (initOptions?: LibraryAddOptions) => {
    if (running.current || !active.current) return;
    setConnectionErrorProvider("obsidian");
    if (!obsidianPath.trim()) {
      setConnectionError("请输入 Obsidian Vault 文件夹路径");
      return;
    }
    running.current = true;
    setConnectingAction("obsidian");
    setConnectionError("");
    try {
      const library = await invoke<LibrarySummary>("add_obsidian_library", { path: obsidianPath.trim(), initOptions });
      if (!active.current) return;
      const libraries = await reloadSpaces();
      if (!active.current) return;
      selectOnlyLibrary(library.id);
      await refreshStatus();
      if (!active.current) return;
      await libraryManagement.refresh();
      if (!active.current) return;
      showOperationStatus(initOptions?.startNow === false ? "资料库已添加并暂停，可稍后继续" : "资料库已添加，后台开始处理", "success");
      if (!libraries.some((item) => item.id === library.id)) {
        throw new Error("Obsidian 资料库登记后未出现在列表中");
      }
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setConnectingAction(null);
    }
  }, [selectOnlyLibrary, selectLibraries, focusSearch, obsidianPath, refreshStatus, reloadSpaces, libraryManagement.refresh, showOperationStatus]);

  useEffect(() => {
    if (registryError && !running.current) { setConnectionErrorProvider("general"); setConnectionError(registryError); }
  }, [registryError]);
  useEffect(() => {
    if (ready && spaces.length === 0 && import.meta.env.VITE_AUTO_CONNECT === "true" && mcpUrl && !autoConnectStarted.current) {
      autoConnectStarted.current = true;
      void connect({ startNow: true, contentPolicy: { imageDownload: null,imageOcr: null,pdfDownload: null,pdfText: null,pdfOcr: null,otherDownload: null,outgoingAttachments: null } });
    }
  }, [connect,mcpUrl,ready,spaces.length]);
  return { mcpUrl,setMcpUrl,craftApiUrl,setCraftApiUrl,craftApiKey,setCraftApiKey,obsidianPath,setObsidianPath,
    connectingAction,connectionError,setConnectionError,connectionErrorProvider,setConnectionErrorProvider,
    feishuAppId,setFeishuAppId,feishuAppSecret,setFeishuAppSecret,feishuAuthorization,setFeishuAuthorization,
    selectedFeishuSpaceIds,setSelectedFeishuSpaceIds,feishuBitableUrl,setFeishuBitableUrl,feishuBitableSourceId,setFeishuBitableSourceId,
    connect,saveCraftApiConnection,connectDida365,connectFeishu,addSelectedFeishuSpaces,addFeishuBitable,addObsidian };
}
