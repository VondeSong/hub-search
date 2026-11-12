import type { TagTask } from './tag-assistant';

export function cleanTagStarter(input: string) {
  return /^(?:帮我)?(?:起草标签定义|查找可能漏标的内容|比较两个标签|比较标签关系)[：:]?\s*$/.test(input.trim()) ? '' : input;
}

export function prepareTagTask(intent: TagTask['intent'], tags: string[], target: string, other: string, hasScope: boolean, hasDefinition: boolean): { task: TagTask } | { error: string } {
  if (!target || !tags.includes(target)) return { error: '请选择本次处理的标签。' };
  if (intent === 'relation' && (!other || target === other || !tags.includes(other))) return { error: '请选择两个不同的标签进行比较。' };
  if (intent === 'definition' && !hasScope) return { error: '请先在资料范围中选择分析资料库。' };
  if (intent !== 'definition' && !hasScope) return { error: '请先选择本次核对的资料范围。' };
  if (intent === 'missing' && !hasDefinition) return { error: '请先起草并确认这个标签的定义。' };
  return { task: { intent, tag: target, ...(intent === 'relation' ? { other } : {}) } };
}
