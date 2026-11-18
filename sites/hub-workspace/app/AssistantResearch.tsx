"use client";

import { ChevronDown, Pin, PinOff, Search, X } from 'lucide-react';
import type { AssistantContext } from './Assistant';

export const researchPolicies = [
  { id: 'material-first', name: '优先用所选资料', hint: '先读所选资料，再按联网设置补充。' },
  { id: 'materials-only', name: '只用所选资料', hint: '回答只使用所选资料。' },
  { id: 'open', name: '开放研究', hint: '围绕问题研究，选定材料作为背景与约束。' },
] as const;
export type ResearchPolicy = typeof researchPolicies[number]['id'];
export type ResearchTopic = { id: string; name: string; policy: ResearchPolicy; pageIds: string[]; libraryIds: string[]; skillIds?: string[]; pageLabels?: Record<string, string>; libraryLabels?: Record<string, string> };
export const topicStorageKey = 'hub-proto-agent-topics-v1';

export function readTopics(raw: unknown): ResearchTopic[] {
  if (!Array.isArray(raw)) return [];
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 500))].slice(0, 31) : [];
  return raw.flatMap(value => {
    if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name.trim()) return [];
    const pageIds = ids(value.pageIds), libraryIds = ids(value.libraryIds);
    const labels = (raw: unknown, keys: string[]) => Object.fromEntries(keys.flatMap(id => {
      const label = raw && typeof raw === 'object' && Object.hasOwn(raw, id) ? (raw as Record<string, unknown>)[id] : undefined;
      return typeof label === 'string' && label ? [[id, label.slice(0, 400)]] : [];
    }));
    return [{ id: value.id, name: value.name.slice(0, 60), policy: researchPolicies.find(p => p.id === value.policy)?.id || 'material-first',
      pageIds, libraryIds, skillIds: ids(value.skillIds).slice(0, 6), pageLabels: labels(value.pageLabels, pageIds), libraryLabels: labels(value.libraryLabels, libraryIds) }];

  }).slice(0, 30);
}

export type TopicSource = { id: string; kind: '页面' | '资料库'; label: string; available: boolean };

export function resolveTopicSources(scope: Pick<ResearchTopic, 'pageIds' | 'libraryIds' | 'pageLabels' | 'libraryLabels'>, catalog: AssistantContext[]) {
  const pagesById = new Map(catalog.map(item => [item.id, item]));
  const librariesById = new Map(catalog.filter(item => item.libraryId).map(item => [item.libraryId!, item.libraryName || item.libraryId!]));
  const savedLabel = (labels: Record<string, string> | undefined, id: string) => labels && Object.hasOwn(labels, id) ? labels[id] : id;
  const sources: TopicSource[] = [
    ...scope.pageIds.map(id => ({ id, kind: '页面' as const, label: pagesById.get(id)?.title || savedLabel(scope.pageLabels, id), available: pagesById.has(id) })),
    ...scope.libraryIds.map(id => ({ id, kind: '资料库' as const, label: librariesById.get(id) || savedLabel(scope.libraryLabels, id), available: librariesById.has(id) })),
  ];
  return { sources, pages: scope.pageIds.flatMap(id => pagesById.get(id) || []), libraryIds: scope.libraryIds.filter(id => librariesById.has(id)) };
}

export function TopicSourceReview({ sources, onRemove }: { sources: TopicSource[]; onRemove?: (source: TopicSource) => void }) {
  const available = sources.filter(item => item.available), missing = sources.filter(item => !item.available);
  const row = (item: TopicSource) => <li key={item.kind + item.id}><span>{item.kind}</span>{item.label}{onRemove && <button type="button" className="ha-icon ha-topic-item-remove ha-chip-remove" aria-label={'从当前专题移除' + item.kind + ' ' + item.label} onClick={() => onRemove(item)}><X size={13}/></button>}</li>;
  return <div className="ha-topic-review">
    {available.length > 0 && <div><strong>可用资料</strong><ul>{available.map(row)}</ul></div>}
    {missing.length > 0 && <div><strong>不可用资料</strong><ul>{missing.map(row)}</ul></div>}
  </div>;
}

// Explicit pages come first. Example library lookup only returns candidates matching the question.
export function researchSources(question: string, explicit: AssistantContext[], libraryIds: string[], catalog: AssistantContext[]) {
  const core = [...new Map(explicit.map(item => [item.id, item])).values()];
  const terms = question.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g)?.flatMap(term => /^[a-z0-9]+$/.test(term) ? [term] : Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))) || [];
  const tokens = [...new Set(terms)].filter(term => !['根据', '这些', '资料', '哪些', '需要', '什么', '请核', '要点', '确认'].includes(term));
  const found = catalog.filter(item => libraryIds.includes(item.libraryId || '') && !core.some(page => page.id === item.id) && !!item.excerpt.trim()).map(item => {
    const title = item.title.toLowerCase(), excerpt = item.excerpt.toLowerCase();
    return { item, score: tokens.reduce((score, token) => score + (title.includes(token) ? 3 : excerpt.includes(token) ? 1 : 0), 0) };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(hit => hit.item);
  return [...core, ...found];
}

export type WorkPins = { skills: string[]; topics: string[] };
export const workPinsKey = 'hub-proto-agent-work-pins-v1';

export function readWorkPins(raw: unknown): WorkPins {
  const data = raw && typeof raw === 'object' ? raw as Partial<WorkPins> : {};
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 180))].slice(0, 30) : [];
  return { skills: ids(data.skills), topics: ids(data.topics) };
}

export function PinShortcut({ kind, title, pinned, onToggle }: { kind: '技能' | '专题'; title: string; pinned: boolean; onToggle: () => void }) {
  const label = (pinned ? '取消置顶' : '置顶') + kind + '：' + title;
  return <button type="button" className="ha-icon ha-pin-shortcut" aria-pressed={pinned} aria-label={label} title={label} onClick={onToggle}>{pinned ? <PinOff size={15}/> : <Pin size={15}/>}</button>;
}

export function MaterialScopeButton({ open, onToggle, libraries, pages }: { open: boolean; onToggle: () => void; libraries: number; pages: number }) {
  const scope = [pages ? pages + ' 份材料' : '', libraries ? libraries + ' 个库' : ''].filter(Boolean).join(' · ');
  const label = scope ? '资料范围：' + scope : '资料范围';
  return <button type="button" className="ha-scope-trigger" aria-label={label} title={label} aria-expanded={open} onClick={onToggle}><Search size={16}/><span>{scope || '资料范围'}</span><ChevronDown size={12}/></button>;
}
