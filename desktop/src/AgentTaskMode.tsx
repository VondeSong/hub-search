import { Check, ChevronDown, X } from "lucide-react";
import { useAgentPopover } from "./useAgentPopover";

export function AgentTaskMode({ title, value, disabled, onChange }: {
  title: string;
  value: string;
  disabled: boolean;
  onChange: (value: "quick" | "deep") => void;
}) {
  const popover = useAgentPopover();
  const label = value === "deep" ? "扩展" : "标准";
  return <details ref={popover.ref} className="agent-task-mode" name="hub-agent-header">
    <summary aria-label={`任务模式：${label}`} title={`${title} · ${label}任务额度`}>
      <span className="agent-mode-title">{title}</span><span className="agent-mode-badge">{label}</span><ChevronDown size={13} aria-hidden="true" />
    </summary>
    <section className="agent-mode-menu" aria-label="任务模式">
      <div className="agent-mode-heading"><strong>任务模式</strong><button type="button" aria-label="关闭任务模式" onClick={() => popover.close(true)}><X size={16} aria-hidden="true" /></button></div>
      <p>选择本轮可用的工具步骤、资料量与运行时限。</p>
      {([
        { value: "quick", title: "标准", description: "适合日常问答、整理和一般分析。" },
        { value: "deep", title: "扩展", description: "为多份资料核对与较长任务提供更多执行额度。" },
      ] as const).map(choice => <button key={choice.value} type="button" className="agent-mode-choice" aria-pressed={value === choice.value} disabled={disabled} onClick={() => { onChange(choice.value); popover.close(true); }}>
        <span><strong>{choice.title}</strong><small>{choice.description}</small></span>{value === choice.value && <Check size={17} aria-hidden="true" />}
      </button>)}
      <small className="agent-mode-footnote">模型支持时，可在输入框右下角调整推理强度。</small>
    </section>
  </details>;
}
