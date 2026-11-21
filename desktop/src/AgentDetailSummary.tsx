import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function AgentDetailSummary({ icon, title, status, link = false }: { icon: ReactNode; title: string; status?: string; link?: boolean }) {
  const Chevron = link ? ChevronRight : ChevronDown;
  return <><span className="agent-detail-icon" aria-hidden="true">{icon}</span><span className="agent-detail-title">{title}</span><small>{status}</small><Chevron className="agent-detail-caret" size={14} aria-hidden="true"/></>;
}
