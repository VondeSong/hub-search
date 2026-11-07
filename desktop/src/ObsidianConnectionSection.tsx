import { LibraryAddActions } from "./LibraryAddActions";
import type { LibraryAddOptions, LibraryContentOverrides } from "./LibraryManagement";

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;

type ObsidianConnectionSectionProps = {
  obsidianPath: string;
  connectingAction: ConnectingAction;
  connectionError: string;
  setObsidianPath: (value: string) => void;
  contentPolicy?: LibraryContentOverrides;
  addObsidian: (options?: LibraryAddOptions) => void | Promise<void>;
};

export function ObsidianConnectionSection({
  obsidianPath,
  connectingAction,
  connectionError,
  setObsidianPath,
  addObsidian,
  contentPolicy,
}: ObsidianConnectionSectionProps) {
  return (
    <>
      <h3 className="connection-section-title">选择本地 Vault</h3>
      <label className="url-field"><span>Vault 文件夹路径</span><input value={obsidianPath} onChange={(event) => setObsidianPath(event.target.value)} placeholder="D:\Obsidian\Vault" spellCheck={false} /></label>
      <LibraryAddActions busy={connectingAction !== null} contentPolicy={contentPolicy} onAdd={addObsidian} />
      {connectionError && <div className="connection-error">{connectionError}</div>}
      <div className="security-note">接入时只读取 Vault 中的 Markdown；忽略 .obsidian、.trash、.git 和 .basic-memory。需要修改笔记时，可在 Hub 助手中预览并明确确认保存。</div>
    </>
  );
}
