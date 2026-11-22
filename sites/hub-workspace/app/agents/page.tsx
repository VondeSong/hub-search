import type { Metadata } from 'next';
import { ReferenceSurface } from './ReferenceSurface';

export const metadata: Metadata = {
  title: 'Hub 助手 · 交互原型',
  description: '体验 Hub Agents 的模式、资料范围、工具与成果交互。',
};

export default function AgentsPage() {
  return <ReferenceSurface />;
}
