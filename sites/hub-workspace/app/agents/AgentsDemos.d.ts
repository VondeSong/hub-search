import type { ReactElement } from 'react';
import type { AgentDemoMode } from './demo-data';
import type { ProcessDemoAssets } from '../AssistantProcess';

export type DemoPage = { id: string; title: string; path: string; text: string };
export type DemoApply = { kind: 'insert' | 'note' | 'task'; title: string; body: string; ids: readonly string[]; target: string; expectedBody: string };
export type AgentsDemosProps = {
  initialMode: AgentDemoMode;
  onDismiss: () => void;
  onModeChange?: (mode: AgentDemoMode) => void;
  sourcePages?: DemoPage[];
  insertTargets?: Pick<DemoPage, 'id' | 'title' | 'text'>[];
  onOpenSource?: (id: string) => void;
  onApply?: (action: DemoApply) => void | Promise<void>;
  processAssets?: ProcessDemoAssets;
};
export default function AgentsDemos(props: AgentsDemosProps): ReactElement;
