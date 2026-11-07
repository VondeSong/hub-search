import { useState } from "react";
import { createRoot } from "react-dom/client";
import { appShellStyle, DEFAULT_APP_SETTINGS } from "../src/AppSettings";
import { LibraryIcon } from "../src/LibraryIcon";
import { ManagedSpacesSection } from "../src/ManagedSpacesSection";
import { SettingsDialog } from "../src/SettingsDialog";
import { providerName, providerUnavailableLabel } from "../src/ProviderLabels";
import type { IndexStatus } from "../src/IndexStatusTypes";
import type { LibraryRuntime } from "../src/LibraryManagement";
import type { LibrarySummary } from "../src/SearchTypes";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";

// This browser-only fixture never reads local vaults or contacts an account.
const fixture = {
  calls: [] as { command: string; args: Record<string, unknown> }[],
  unknown: [] as string[],
  relocations: [] as string[],
  actions: [] as { libraryId: string; action: string }[],
  fontSize: DEFAULT_APP_SETTINGS.interfaceFontSize,
};
const policy = {
  imageDownload: true, imageOcr: true, pdfDownload: true, pdfText: true,
  pdfOcr: true, otherDownload: false, outgoingAttachments: true,
};
let callbackId = 0;
Object.assign(window, {
  __LIBRARY_LOCATION_FIXTURE__: fixture,
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      fixture.calls.push({ command, args });
      if (command === "plugin:event|listen") return ++callbackId;
      if (command === "plugin:event|unlisten") return;
      if (command === "library_content_policy") {
        const request = args.args as { libraryId?: string } | undefined;
        return {
          libraryId: request?.libraryId ?? null, provider: "obsidian",
          global: policy, effective: policy,
          overrides: Object.fromEntries(Object.keys(policy).map(key => [key, null])),
          capabilities: { ...policy, otherDownload: true },
        };
      }
      fixture.unknown.push(command);
      throw new Error(`隔离样例未实现 IPC：${command}`);
    },
    convertFileSrc: (path: string) => path,
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

const spaces: LibrarySummary[] = [
  { id: "qa-connected", name: "示例知识库 · 正常", provider: "obsidian", documentCount: 1347, connected: true, location: "Q:\\QA-Examples\\Notes\\SampleVault", excludedPaths: [] },
  { id: "qa-disconnected", name: "示例知识库 · 路径断开", provider: "obsidian", documentCount: 1347, connected: false, location: "Q:\\QA-Examples\\Notes\\OldSampleVault", excludedPaths: [] },
  { id: "qa-updating", name: "示例知识库 · 更新中", provider: "obsidian", documentCount: 1347, connected: false, location: "Q:\\QA-Examples\\Notes\\RenamedSampleVault", excludedPaths: [] },
];
const libraryRuntime: Record<string, LibraryRuntime> = Object.fromEntries(spaces.map(space => [space.id, {
  libraryId: space.id, state: "idle", phase: "idle", detail: "等待下一次更新", activeOperations: 0, pending: 0, updatedAt: 0,
}]));
const indexStatus: IndexStatus = {
  journalVersions: [], documentCount: 4041, pendingJobs: 0, pendingDownloads: 0,
  pendingOcrPages: 0, pendingOtherJobs: 0, deferredOcrSources: 0, failedJobs: 0,
  failedOcrPages: 0, pendingLexicalJobs: 0, rateLimitEvents: 0,
  autoSyncEnabled: false, autoSyncConsecutiveFailures: 0, jobDetails: [], libraryHealth: [],
  obsidianWatchers: spaces.map(space => ({
    libraryId: space.id, watching: space.connected, pendingPaths: 0,
    lastError: space.connected ? undefined : "隔离样例：原文件夹已经改名",
  })),
};
const noop = () => {};

function Fixture() {
  const [open, setOpen] = useState(true);
  const [font, setFont] = useState(new URLSearchParams(location.search).get("font") === "maximum" ? "maximum" : "default");
  const [relocateCount, setRelocateCount] = useState(0);
  const [lastAction, setLastAction] = useState("尚未点击样例操作");
  const interfaceFontSize = font === "maximum" ? 16 : DEFAULT_APP_SETTINGS.interfaceFontSize;
  fixture.fontSize = interfaceFontSize;
  const recordAction = (space: LibrarySummary, action: string) => {
    fixture.actions.push({ libraryId: space.id, action });
    setLastAction(`${space.name}：${action}`);
  };
  return <main className="app-shell desktop-app-shell" style={appShellStyle({ ...DEFAULT_APP_SETTINGS, interfaceFontSize })}>
    <button onClick={() => setOpen(true)}>打开资料库样例设置</button>
    {open && <SettingsDialog canClose category="libraries" onCategoryChange={noop} onClose={() => setOpen(false)}>
      <section className="settings-category libraries" data-qa="library-location-controls" style={{ marginBottom: 16 }}>
        <h3 className="connection-section-title">资料库位置 · 隔离样例</h3>
        <p className="provider-connect-description">使用虚构库名与路径，按钮仅记录点击，不选择或修改文件夹。</p>
        <label className="background-setting-row">
          <span>界面字号</span>
          <select aria-label="样例界面字号" value={font} onChange={event => setFont(event.target.value)}>
            <option value="default">默认（13 px）</option>
            <option value="maximum">最大（16 px）</option>
          </select>
        </label>
        <p data-qa="relocation-feedback" role="status">重新定位点击 {relocateCount} 次 · {lastAction}</p>
      </section>
      <ManagedSpacesSection
        allowVaultExport={false}
        spaces={spaces}
        renderLibraryIcon={space => <LibraryIcon provider={space.provider} name={space.name} />}
        indexStatus={indexStatus}
        libraryRuntime={libraryRuntime}
        relocatingLibraryId="qa-updating"
        relocateObsidian={space => {
          fixture.relocations.push(space.id);
          setRelocateCount(count => count + 1);
          recordAction(space, "重新定位");
        }}
        controlLibrary={(space, action) => recordAction(space, action)}
        providerName={providerName}
        providerUnavailableLabel={providerUnavailableLabel}
        obsidianWatchLabel={status => status?.watching ? "监听中" : "监听中断"}
        renamingLibraryId="" libraryNameDraft="" exportingLibraryId="" exportProgress={null}
        lastExportPath="" exportError="" maintenanceMessage="" editingExclusions="" exclusionDraft=""
        savingExclusions={false} restartingWatcher=""
        beginRenameLibrary={space => recordAction(space, "修改名称")}
        saveLibraryName={noop}
        updateLibraryIcon={space => recordAction(space, "更新图标")}
        resetLibraryIcon={space => recordAction(space, "恢复图标")}
        chooseExportDirectory={async () => undefined}
        exportCraftVault={async () => false}
        editExclusions={space => recordAction(space, "读取范围")}
        restartWatcher={space => recordAction(space, "重建监听")}
        removeSpace={space => recordAction(space, "移除资料库")}
        saveExclusions={noop} openExportPath={noop} openExportInObsidian={noop}
        setRenamingLibraryId={noop} setLibraryNameDraft={noop} setEditingExclusions={noop} setExclusionDraft={noop}
      />
      <section className="settings-category libraries" data-qa="following-section">
        <h3 className="connection-section-title">后续设置区域</h3>
        <p className="provider-connect-description">检查重新定位按钮是否仍在资料库卡片内，且没有覆盖这里的内容。</p>
      </section>
    </SettingsDialog>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
