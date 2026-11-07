import { LibraryAddActions } from "./LibraryAddActions";
import type { LibraryAddOptions, LibraryContentOverrides } from "./LibraryManagement";

type ConnectingAction = "craft" | "dida365" | "feishu" | "feishuBitable" | "obsidian" | null;

type FeishuLibraryOption = {
  id: string;
  name: string;
};

type FeishuBitableConnectionSectionProps = {
  connectedFeishuSpaces: FeishuLibraryOption[];
  feishuBitableSourceId: string;
  feishuBitableUrl: string;
  connectingAction: ConnectingAction;
  setFeishuBitableSourceId: (value: string) => void;
  setFeishuBitableUrl: (value: string) => void;
  contentPolicy?: LibraryContentOverrides;
  addFeishuBitable: (options?: LibraryAddOptions) => void | Promise<void>;
};

export function FeishuBitableConnectionSection({
  connectedFeishuSpaces,
  feishuBitableSourceId,
  feishuBitableUrl,
  connectingAction,
  setFeishuBitableSourceId,
  setFeishuBitableUrl,
  addFeishuBitable,
  contentPolicy,
}: FeishuBitableConnectionSectionProps) {
  const feishuBitableSource = feishuBitableSourceId || connectedFeishuSpaces[0]?.id || "";
  return (
    <details className="connection-extra">
      <summary>通过链接添加多维表格<span>可选 · 补充未自动发现的表格</span></summary>
      <div className="connection-extra-body">
      <p className="provider-connect-description">用于自动发现没有返回的独立 Base。一个数据表显示为一篇文档，只读取前两个字段。</p>
      <label className="url-field"><span>授权账号</span><select value={feishuBitableSource} onChange={(event) => setFeishuBitableSourceId(event.target.value)}>
        {connectedFeishuSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
      </select></label>
      <label className="url-field"><span>多维表格链接</span><input value={feishuBitableUrl} onChange={(event) => setFeishuBitableUrl(event.target.value)} placeholder="https://tenant.feishu.cn/base/...?...table=...&view=..." spellCheck={false} /></label>
      <LibraryAddActions busy={connectingAction !== null} disabled={connectedFeishuSpaces.length === 0} contentPolicy={contentPolicy} onAdd={addFeishuBitable} label="添加多维表格" />
    </div></details>
  );
}
