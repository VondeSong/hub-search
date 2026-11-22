import { ChevronDown, Database } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import { agentLibraryScopeSummary, isAgentLibraryProvider, type AgentLibrary, type AgentLibraryRegistry } from "./useAgentLibraryRegistry";
import "./AgentLibraryScope.css";

export function AgentScopeTrigger({ selected, registry, fallbackLabel, pending = false, disabled = false, onClick }: {
  selected: AgentLibrary[];
  registry: Pick<AgentLibraryRegistry, "libraries" | "loaded">;
  fallbackLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const summary = agentLibraryScopeSummary(selected, registry, fallbackLabel);
  const library = summary.library;
  const description = `${summary.title}${pending ? "；范围修改将在下一条消息生效" : ""}`;
  return <button type="button" className="agent-scope-trigger" aria-label={`搜索范围：${description}`} title={description} disabled={disabled} onClick={onClick}>
    {library && isAgentLibraryProvider(library.provider) ? <LibraryIcon provider={library.provider} name={library.name} iconSvg={library.iconSvg} defaultIconUrl={library.defaultIconUrl} compact /> : <Database size={14} aria-hidden="true" />}
    <span className="agent-scope-trigger-label">{summary.label}</span>
    {(pending || summary.unavailableCount > 0) && <span className="agent-scope-status-dot" aria-hidden="true" />}
    <ChevronDown size={12} aria-hidden="true" />
  </button>;
}
