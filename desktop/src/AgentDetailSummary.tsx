import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function AgentDetailSummary({ icon, title, status }: { icon: ReactNode; title: string; status?: string }) {
  return <><span className="agent-detail-icon" aria-hidden="true">{icon}</span><span className="agent-detail-title">{title}</span><small>{status}</small><ChevronDown className="agent-detail-caret" size={14} aria-hidden="true"/></>;
}
