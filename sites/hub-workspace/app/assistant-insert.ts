import type { HubItem, Section } from './data';
export type PageInsertion = { targetId: string; expectedBody: string; body: string; sourceIds: string[]; operationId: string };
export const pageBody = (sections: Section[]) => sections.map(section => section.text || section.items?.join('\n') || '').join('\n\n');
export const visibleAssistantSections = (sections: Section[], accessible: (id: string) => boolean) => sections.filter(section => (section.assistantSourceIds || []).every(accessible));
export function appendAssistantAnswer(item: HubItem, insertion: PageInsertion): HubItem {
  if (!insertion.operationId || !insertion.body.trim() || insertion.body.length > 100000 || item.id !== insertion.targetId) throw Error('插入内容或目标页面无效');
  if (item.sections.some(section => section.assistantOperationId === insertion.operationId)) return item;
  if (pageBody(item.sections) !== insertion.expectedBody) throw Error('目标页面已变化，请重新选择并核对后再插入');
  const sourceIds = [...new Set(insertion.sourceIds)];
  const sections: Section[] = [{ type: 'h2', text: '助手补充', assistantSourceIds: sourceIds, assistantOperationId: insertion.operationId }, ...insertion.body.trim().split(/\n\s*\n/).filter(Boolean).map(text => ({ type: 'p' as const, text, assistantSourceIds: sourceIds }))];
  return { ...item, sections: [...item.sections, ...sections] };
}
