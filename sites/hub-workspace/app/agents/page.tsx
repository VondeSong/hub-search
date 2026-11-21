import type { Metadata } from 'next';
import { ReferenceSurface } from './ReferenceSurface';

export const metadata: Metadata = {
  title: 'Hub 助手 · 交互原型',
  description: '体验 Hub Agents 的模式、资料范围、工具与成果交互。',
};

export default function AgentsPage() {
  return <>
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
      precedence="default"
    />
    <ReferenceSurface />
  </>;
}
