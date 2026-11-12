import { useEffect, useState } from "react";
import {
  Image,
  Video,
  FileText,
  Paperclip,
  Check,
  BookOpenCheck,
  Bookmark,
  PencilLine,
} from "lucide-react";
export type Module = "flashcards" | "reading" | "quick";
export type Selection = {
  image: boolean;
  video: boolean;
  pdf: boolean;
  other: boolean;
  maxMb: number;
};
export type Transfers = Record<
  Module,
  { upload: Selection; download: Selection }
>;
export const moduleNames = {
  flashcards: "闪卡",
  reading: "阅读",
  quick: "速记",
};
const icons = { image: Image, video: Video, pdf: FileText, other: Paperclip };
const names = { image: "图片", video: "视频", pdf: "PDF", other: "其他" };
export function ModuleIcon({ id }: { id: Module }) {
  const Icon =
    id === "flashcards"
      ? BookOpenCheck
      : id === "reading"
        ? Bookmark
        : PencilLine;
  return <Icon size={18} aria-hidden="true" />;
}
function PolicyRow({
  id,
  direction,
  value,
  disabled,
  change,
}: {
  id: Module;
  direction: "upload" | "download";
  value: Selection;
  disabled: boolean;
  change: (v: Selection) => void;
}) {
  const [size, setSize] = useState(String(value.maxMb));
  useEffect(() => setSize(String(value.maxMb)), [value.maxMb]);
  const verb = direction === "upload" ? "上传" : "自动下载",
    max = id === "flashcards" ? 250 : id === "reading" ? 100 : 20;
  return (
    <div className="cloud-policy-row">
      <span className="cloud-policy-name">
        <ModuleIcon id={id} />
        {moduleNames[id]}
      </span>
      <div
        className="cloud-type-options"
        role="group"
        aria-label={`${moduleNames[id]}${verb}类型`}
      >
        {(Object.keys(names) as (keyof typeof names)[]).map((type) => {
          const Icon = icons[type];
          return (
            <label key={type}>
              <input
                type="checkbox"
                checked={value[type]}
                disabled={disabled}
                aria-label={`${moduleNames[id]}${verb}${names[type]}`}
                onChange={(e) => change({ ...value, [type]: e.target.checked })}
              />
              <span>
                <Icon size={14} />
                {names[type]}
                <Check className={value[type] ? "" : "unselected"} size={12} />
              </span>
            </label>
          );
        })}
      </div>
      <label className="cloud-size-field">
        <span>单个上限</span>
        <span>
          <input
            type="number"
            aria-label={`${moduleNames[id]}${verb}单个附件上限`}
            min={1}
            max={max}
            title={`1–${max} MB`}
            step={1}
            disabled={disabled}
            value={size}
            onChange={(e) => setSize(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={() => {
              const n = Number(size);
              setSize(String(value.maxMb));
              if (Number.isInteger(n) && n >= 1 && n <= max) {
                if (n !== value.maxMb) change({ ...value, maxMb: n });
              }
            }}
          />
          <span>MB</span>
        </span>
      </label>
    </div>
  );
}
export function CloudAttachmentPolicies({
  value,
  modules,
  disabled,
  onChange,
}: {
  value: Transfers;
  modules: Record<Module, boolean>;
  disabled: boolean;
  onChange: (
    id: Module,
    direction: "upload" | "download",
    p: Selection,
  ) => void;
}) {
  return (
    <>
      {(["upload", "download"] as const).map((direction) => (
        <section
          className="cloud-transfer-group"
          key={direction}
          aria-label={direction === "upload" ? "上传到云端" : "下载到本机"}
        >
          <h3>{direction === "upload" ? "上传到云端" : "下载到本机"}</h3>
          <p>
            {direction === "upload"
              ? "正文与记录随同步上传，附件由你选择。"
              : "选择自动下载的附件，未选或超出上限时手动下载。"}
          </p>
          <div className="cloud-policy-rows">
            {(Object.keys(moduleNames) as Module[]).map((id) => (
              <PolicyRow
                key={id}
                id={id}
                direction={direction}
                value={value[id][direction]}
                disabled={disabled || !modules[id]}
                change={(p) => onChange(id, direction, p)}
              />
            ))}
          </div>
          <p>
            {direction === "upload"
              ? "未上传的附件保留在本机，放宽规则后可补传。"
              : "仅控制本机自动下载，不影响上传或已有文件。"}
          </p>
        </section>
      ))}
    </>
  );
}
