"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import {
  ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, FileText, Layers,
  Paperclip, Play, Sparkles, Square, X, Copy, FilePlus2,
  ListPlus, PencilLine, CornerDownRight, Link2, WandSparkles, BookOpen, CircleHelp, Tags, Search,
} from 'lucide-react';

import { parseTagRequest, tagIntents, tagPrompt, tagRuleLibrary, type TagReviewModel, type TagTask } from './tag-assistant';
import { cleanTagStarter, prepareTagTask } from './tag-task';
import { TagContext, TagPicker, TagReviewCard, TagTaskSelector } from './TagAssistant';
import { AssistantInsert } from './AssistantInsert';
import { AssistantProcess, AssistantProcessDemo } from './AssistantProcess';
import { AssistantTokens } from './AssistantTokens';
import type { PageInsertion } from './assistant-insert';
import { MaterialScopeButton, readTopics, readWorkPins, researchPolicies, researchSources, resolveTopicSources, topicStorageKey, workPinsKey, type ResearchPolicy, type ResearchTopic, type WorkPins } from './AssistantResearch';
import { ActiveTopicChip, AssistantTaskModes, AssistantTopicReview } from './AssistantTaskModes';
import { AssistantMaterialScope } from './AssistantMaterialScope';
import { ResourceChips, demoSkills, emptyResources, publicLinkIn, type ResourceDraft } from './AssistantResources';
import { libraryDragType } from './assistant-library-drag';
import { AssistantHeader, AssistantTools, clampPanelSize, type AssistantMenu, type HistoryItem } from './AssistantChrome';

export type AssistantEvidence = { id: string; title: string; source?: string; excerpt?: string };
export type AssistantContext = {
  id: string;
  title: string;
  excerpt: string;
  workId?: string;
  workTitle?: string;
  revision?: number;
  evidence?: AssistantEvidence[];
  writable?: boolean; kind?: string; libraryId?: string; libraryName?: string; path?: string;
};
export type Context = AssistantContext;
type Model = 'codex' | 'deepseek';
type TaskMode = 'auto' | 'standard' | 'extended';
type Thinking = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Speed = 'standard' | 'fast';
export type AssistantSettings = { researchPolicy: ResearchPolicy; model: Model; taskMode: TaskMode; thinking: Thinking; speed: Speed; webSearch: 'disabled' | 'cached' | 'live'; externalMcp: boolean; deepseekThinking: boolean; modelId: string | null; reasoningDefault: boolean; autoFlashcardInbox: boolean; mcpServices: string[]; memoryEnabled: boolean; memoryScope: string; inputLimit: number; outputLimit: number };
type Settings = AssistantSettings;
type Request = Settings & { id: string; text: string; context: AssistantContext | null; additions: string[]; attachmentNames: string[]; resources?: ResourceDraft; researchDemo?: boolean; tagTask?: TagTask };
type Active = Request & { status: 'running' | 'paused'; revision: number };
type Section = { heading: string; body: string; sourceIds?: string[] };
type TagResult = { ids: string[]; message: string; next?: 'scope' | 'definition'; process?: string[] };
type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  context?: AssistantContext | null;
  sections?: Section[];
  processWebEnabled?: boolean;
  model?: Model;
  attachmentNames?: string[]; resources?: ResourceDraft; tagTask?: TagTask; tagResult?: TagResult;
};
type Session = { messages: Message[]; active: Active | null; queue: Request[]; frozen: boolean };
type Action =
  | { type: 'send'; request: Request }
  | { type: 'tag-turn'; request: Request; reply: Message }
  | { type: 'append'; text: string; id: string; attachmentNames: string[]; url?: string }
  | { type: 'stop' | 'continue' }
  | { type: 'discard-active' }
  | { type: 'complete'; id: string }
  | { type: 'remove'; id: string };
type Draft = { kind: 'note' | 'task'; title: string; body: string; context: AssistantContext | null };
type ActiveTopic = Pick<ResearchTopic, 'id' | 'name' | 'policy'> & { scope: ResourceDraft; useManualOnce: boolean; previousPolicy: ResearchPolicy };
type Conversation = Settings & {
  session: Session;
  input: string;
  inputContext: AssistantContext | null;
  attachmentNames: string[];
  contexts: AssistantContext[];
  omittedId: string | null;
  title: string; resources: ResourceDraft; activeTopic: ActiveTopic | null; updatedAt?: number;
  tagMode: boolean; tag: string; tagRefs: string[]; tagIntent: TagTask['intent'] | null; tagOther: string;
};

export type AssistantProps = {
  onOpenTagQueue: (id: string) => void;
  tagEntry: { tag?: string; task?: TagTask } | null; onTagEntryHandled: () => void; tagModel: TagReviewModel;
  open: boolean;
  sourceDemo?: boolean;
  activityDemo?: boolean;
  onCloseActivityDemo?: () => void;
  expanded: boolean;
  context: AssistantContext | null;
  catalog?: AssistantContext[]; currentPageId?: string; onInsertPage?: (value: PageInsertion) => void | Promise<void>;
  canUseContext?: (context: AssistantContext | null | undefined) => boolean;
  onClose: () => void;
  onExpand: () => void;
  onOpenSource?: (id: string) => void;
  onCreateDraft: (kind: 'note' | 'task', title: string, body: string, context?: AssistantContext | null) => void;
  notify: (message: string) => void;
};

const STORAGE_KEY = 'hub-proto-assistant-v2';
const LEGACY_STORAGE_KEY = 'hub-proto-assistant-v1';
const EMPTY: Session = { messages: [], active: null, queue: [], frozen: false };
const allowContext = () => true;
const uniqueId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const concise = (text: string, length = 180) => {
  const clean = text.replace(/[#>*\u0060]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? clean.slice(0, length) + '…' : clean;
};
const plain = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown, limit = 8) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, limit).map(item => item.slice(0, 500)) : [];

function readContext(value: unknown): AssistantContext | null {
  const raw = plain(value);
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  const evidence: AssistantEvidence[] = Array.isArray(raw.evidence) ? raw.evidence.flatMap((entry: unknown) => {
    const item = plain(entry);
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') return [];
    return [{
      id: item.id.slice(0, 180), title: item.title.slice(0, 300),
      source: typeof item.source === 'string' ? item.source.slice(0, 180) : undefined,
      excerpt: typeof item.excerpt === 'string' ? item.excerpt.slice(0, 2400) : undefined,
    }];
  }).slice(0, 40) : [];
  return {
    id: raw.id.slice(0, 180),
    title: raw.title.slice(0, 300),
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt.slice(0, 8000) : '',
    workId: typeof raw.workId === 'string' ? raw.workId.slice(0, 180) : undefined,
    workTitle: typeof raw.workTitle === 'string' ? raw.workTitle.slice(0, 300) : undefined,
    revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : undefined,
    evidence, kind: typeof raw.kind === 'string' ? raw.kind : undefined, libraryId: typeof raw.libraryId === 'string' ? raw.libraryId.slice(0, 180) : undefined, libraryName: typeof raw.libraryName === 'string' ? raw.libraryName.slice(0, 200) : undefined, path: typeof raw.path === 'string' ? raw.path.slice(0, 500) : undefined,
  };
}

function readSettings(value: unknown, preserveRequestMode = false): Settings {
  const raw = plain(value) || {};
  return {
    researchPolicy: raw.researchPolicy === 'materials-only' || raw.researchPolicy === 'open' ? raw.researchPolicy : 'material-first',
    model: raw.model === 'deepseek' ? 'deepseek' : 'codex',
    taskMode: preserveRequestMode && (raw.taskMode === 'standard' || raw.taskMode === 'extended') ? raw.taskMode : 'auto',
    thinking: ['minimal', 'low', 'high', 'xhigh', 'max'].includes(String(raw.thinking)) ? raw.thinking as Thinking : 'medium',
    speed: raw.speed === 'fast' ? 'fast' : 'standard',
    webSearch: raw.webSearch === 'disabled' || raw.webSearch === 'cached' ? raw.webSearch : 'live',
    externalMcp: raw.externalMcp === true, deepseekThinking: raw.deepseekThinking !== false,
    modelId: ['codex-general', 'codex-analysis', 'codex-6-astra', 'codex-6-sol', 'codex-6-luna', 'codex-56-terra', 'codex-56-luna', 'deepseek-general', 'deepseek-analysis'].includes(String(raw.modelId)) && String(raw.modelId).startsWith(raw.model === 'deepseek' ? 'deepseek-' : 'codex-') ? String(raw.modelId) : null,
    reasoningDefault: raw.reasoningDefault !== false,
    autoFlashcardInbox: raw.autoFlashcardInbox === true,
    mcpServices: strings(raw.mcpServices).filter(item => ['Craft', 'Obsidian', '滴答清单'].includes(item)),
    memoryEnabled: raw.memoryEnabled === true, memoryScope: raw.memoryScope === 'hub' ? 'hub' : 'general',
    inputLimit: Number.isSafeInteger(raw.inputLimit) && Number(raw.inputLimit) > 0 ? Number(raw.inputLimit) : 0,
    outputLimit: Number.isSafeInteger(raw.outputLimit) && Number(raw.outputLimit) > 0 ? Number(raw.outputLimit) : 0,
  };
}

function readResources(value: unknown, legacySkill?: unknown): ResourceDraft {
  const raw = plain(value) || {};
  let url = ''; try { const parsed = new URL(String(raw.url || '')); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.href.length <= 2000) url = parsed.href; } catch {}
  return { pages: Array.isArray(raw.pages) ? raw.pages.flatMap(value => { const item = readContext(value); return item ? [item] : []; }).slice(0, 31) : [], libraryIds: strings(raw.libraryIds, 20), skills: [...new Set([...strings(raw.skills, 6), ...(typeof legacySkill === 'string' ? [legacySkill] : [])])].filter(item => /^hub-(research|statistics|flashcards|note-edit|archive|tool-guide)$/.test(item)), images: strings(raw.images, 8), dataFiles: strings(raw.dataFiles,8), url };
}

function readTagTask(value:unknown):TagTask|undefined {
  const raw=plain(value);
  if(!raw || !["definition","missing","relation"].includes(String(raw.intent)) || typeof raw.tag!=="string")return;
  return {intent:raw.intent as TagTask["intent"],tag:raw.tag,other:typeof raw.other==="string"?raw.other:undefined,libraries:Array.isArray(raw.libraries)?strings(raw.libraries):undefined};
}
function readRequest(value: unknown): Request | null {
  const raw = plain(value);
  if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  return {
    ...readSettings(raw, true), id: raw.id, text: raw.text.slice(0, 8000), context: readContext(raw.context),
    researchDemo: raw.researchDemo === true, tagTask:readTagTask(raw.tagTask), additions: strings(raw.additions, 20), attachmentNames: strings(raw.attachmentNames), resources: readResources(raw.resources, raw.taskKind),
  };
}

function readSession(value: unknown): Session {
  const raw = plain(value);
  if (!raw) return EMPTY;
  const messages: Message[] = Array.isArray(raw.messages) ? raw.messages.flatMap((entry: unknown): Message[] => {
    const message = plain(entry);
    if (!message || typeof message.id !== 'string' || typeof message.text !== 'string' || !['user', 'assistant'].includes(String(message.role))) return [];
    const sections: Section[] = Array.isArray(message.sections) ? message.sections.flatMap((item: unknown) => {
      const section = plain(item);
      return section && typeof section.heading === 'string' && typeof section.body === 'string' ? [{ heading: section.heading.slice(0, 180), body: section.body.slice(0, 8000), ...(Array.isArray(section.sourceIds) ? { sourceIds: strings(section.sourceIds, 32) } : {}) }] : [];
    }).slice(0, 12) : [];
    const result = plain(message.tagResult);
    return [{
      id: message.id, role: message.role as Message['role'], text: message.text.slice(0, 12000),
      context: readContext(message.context), sections, processWebEnabled: message.processWebEnabled === true, model: readSettings(message).model,
      attachmentNames: strings(message.attachmentNames), resources: readResources(message.resources), tagTask:readTagTask(message.tagTask),
      tagResult: typeof result?.message === 'string' ? { ids: strings(result.ids, 31), message: result.message, next: result.next === 'scope' || result.next === 'definition' ? result.next : undefined, process: strings(result.process, 12) } : undefined,
    }];
  }).slice(-50) : [];
  const request = readRequest(raw.active);
  const active = request ? { ...request, status: 'paused' as const, revision: 0 } : null;
  const queue = Array.isArray(raw.queue) ? raw.queue.flatMap((entry: unknown) => {
    const item = readRequest(entry);
    return item ? [item] : [];
  }).slice(0, 8) : [];
  return { messages, active, queue, frozen: !!active || !!queue.length };
}

function readTopicDraft(value: unknown, resources: ResourceDraft): { activeTopic: ActiveTopic | null; resources: ResourceDraft } {
  const raw = plain(value);
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name.trim()) return { activeTopic: null, resources };
  const storedScope = plain(raw.scope);
  // Older prototypes stored both selections together. Recover only provenance that was recorded.
  const scope = storedScope ? readResources(storedScope) : {
    pages: resources.pages.filter(item => strings(raw.pageIds, 31).includes(item.id)),
    libraryIds: resources.libraryIds.filter(id => strings(raw.libraryIds, 20).includes(id)),
    skills: resources.skills.filter(id => strings(raw.addedSkillIds, 6).includes(id)), url: '', images: [],
  };
  const manual = storedScope ? resources : { ...resources,
    pages: resources.pages.filter(item => !scope.pages.some(page => page.id === item.id)),
    libraryIds: resources.libraryIds.filter(id => !scope.libraryIds.includes(id)),
    skills: resources.skills.filter(id => !scope.skills.includes(id)),
  };
  return { resources: manual, activeTopic: { id: raw.id.slice(0, 500), name: raw.name.slice(0, 60), scope, useManualOnce: !!storedScope && raw.useManualOnce === true,
    policy: readSettings({ researchPolicy: raw.policy }).researchPolicy, previousPolicy: readSettings({ researchPolicy: raw.previousPolicy }).researchPolicy } };
}

function resourcesForTurn(manual: ResourceDraft, topic: ActiveTopic | null): ResourceDraft {
  if (!topic) return manual;
  const extra = topic.useManualOnce ? manual : { pages: [], libraryIds: [], url: '', images: [], dataFiles: [] };
  return {
    pages: [...topic.scope.pages, ...extra.pages.filter(item => !topic.scope.pages.some(page => page.id === item.id))],
    libraryIds: [...new Set([...topic.scope.libraryIds, ...extra.libraryIds])],
    skills: [...new Set([...manual.skills, ...topic.scope.skills])],
    url: extra.url, images: extra.images, dataFiles: extra.dataFiles||[],
  };
}

function readConversation(value: unknown): Conversation {
  const raw = plain(value) || {};
  return {
    ...readSettings(raw),
    session: readSession(raw.session),
    tagMode: raw.tagMode === true, tag: typeof raw.tag === 'string' ? raw.tag : '', tagRefs: strings(raw.tagRefs, 8), tagIntent: ['definition','missing','relation'].includes(String(raw.tagIntent)) ? raw.tagIntent as TagTask['intent'] : null, tagOther: typeof raw.tagOther === 'string' ? raw.tagOther : '',
    input: typeof raw.input === 'string' ? raw.input.slice(0, 8000) : '',
    inputContext: readContext(raw.inputContext) || (typeof raw.input === 'string' && raw.input && Array.isArray(raw.contexts) ? readContext(raw.contexts[raw.contexts.length - 1]) : null),
    attachmentNames: strings(raw.attachmentNames),
    contexts: Array.isArray(raw.contexts) ? raw.contexts.flatMap((entry: unknown) => {
      const item = readContext(entry);
      return item ? [item] : [];
    }).slice(-24) : [],
    omittedId: typeof raw.omittedId === 'string' ? raw.omittedId : null,
    ...readTopicDraft(raw.activeTopic, readResources(raw.resources, raw.taskKind)),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '自由讨论', updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined,
  };
}

function includeContext(contexts: AssistantContext[], incoming: AssistantContext | null): AssistantContext[] {
  const context = readContext(incoming);
  if (!context) return contexts;
  const previous = contexts.find(item => item.id === context.id);
  if (previous && JSON.stringify(previous) === JSON.stringify(context)) return contexts;
  return [...contexts.filter(item => item.id !== context.id), context].slice(-24);
}

function collectEvidence(contexts: AssistantContext[]): AssistantEvidence[] {
  const result = new Map<string, AssistantEvidence>();
  for (const item of contexts) for (const evidence of item.evidence || []) result.set(evidence.id, evidence);
  return [...result.values()];
}

function pauseConversation(conversation: Conversation): Conversation {
  const session = conversation.session;
  if (!session.active && !session.queue.length) return conversation;
  return { ...conversation, session: { ...session, active: session.active ? { ...session.active, status: 'paused' } : null, frozen: true } };
}

function userMessage(request: Request): Message {
  return { id: request.id + '-user', role: 'user', text: request.text, context: request.context, attachmentNames: request.attachmentNames, resources: request.resources };
}

const isMediaReference = (item: AssistantContext) => item.kind === 'image' || item.kind === 'attachment';

function requestDetails(request: Active): Section[] {
  const sections: Section[] = [];
  const link = request.resources?.url;
  if (link && request.researchPolicy !== 'materials-only') sections.push({ heading: '公开链接 · 未读取', body: link + '。原型仅记录链接。' });
  const media = request.resources?.pages.filter(isMediaReference) || [];
  if (media.length) sections.push({ heading: '资料库附件', body: media.map(item => item.title).join('、') + '。原型保留引用，未分析附件内容。' });
  if (request.resources?.images.length) sections.push({ heading: '图片 · 原型占位示例', body: request.resources.images.join('、') + '。未执行真实看图分析。' });
  if (request.resources?.dataFiles?.length) sections.push({heading:'表格与数据文件 · 演示',body:request.resources.dataFiles.join('、')+'。原型仅保留选择，未执行计算或生成文件。'});
  if (request.additions.length) sections.push({ heading: '已带入的补充条件', body: request.additions.join('；') });
  if (request.attachmentNames.length) sections.push({ heading: '附件名称', body: request.attachmentNames.join('、') + '。本轮只记录文件名，未读取或上传文件内容。' });
  return sections;
}

function demoReply(request: Active): Message {
  const question = request.text + ' ' + request.additions.join(' ');
  const material = request.context;
  if (request.tagTask) return {id:request.id+'-reply',role:'assistant',model:request.model,text:'这条请求可在标签工作区继续处理。',tagTask:request.tagTask};
  if (request.researchDemo) {
    const policy = researchPolicies.find(item => item.id === request.researchPolicy) || researchPolicies[0];
    const evidence = (material?.evidence || []).filter(item => item.excerpt?.trim()).slice(0, 4);
    const missing = (material?.evidence || []).length - evidence.length;
    const web = request.researchPolicy === 'materials-only' ? '本轮仅依据选定材料，网页补充已关闭。' : request.model !== 'codex' ? '当前模型没有网页搜索入口。' : request.webSearch === 'disabled' ? '当前对话已关闭网页搜索。' : '可在正式版按策略补充公开来源；本站没有执行联网检索。';
    return {
      id: request.id + '-reply', role: 'assistant', model: request.model,
      text: policy.name + (evidence.length ? ' · 以下是本轮匹配到的示例摘录。' : ' · 没有找到可支持回答的材料。'),
      context: material ? { ...material, evidence } : null,
      sections: [
        ...evidence.map((item, index) => ({ heading: (index + 1) + '. ' + item.title, body: concise(item.excerpt || '', 420), sourceIds: [item.id] })),
        { heading: '待核对', body: (missing ? '还有 ' + missing + ' 份候选没有在此展开。' : '') + '这是交互演示，摘录只能帮助定位依据；要回答具体问题，还需核对原文及其适用条件。' },
        { heading: '网页补充', body: web },
        ...(request.resources?.skills.length ? [{ heading: '已选技能 · 演示', body: request.resources.skills.map(id => demoSkills.find(skill => skill[0] === id)?.[1] || id).join('、') + '。原型只演示技能选择。' }] : []),
        ...requestDetails(request),
      ],
    };
  }
  const subject = material ? '「' + concise(material.title, 35) + '」' : '这次讨论';
  const isDxf = material?.workId === 'work-dxf-validation' || /^(mapping-change|dxf|review-prep)$/.test(material?.id || '');
  const isAssembly = material?.workId === 'work-assembly-review' || /^(assembly|archive|version-followup)$/.test(material?.id || '');
  let text = material ? '我把' + subject + '整理成了一份可继续编辑的要点。' : '可以先把你的想法整理成一份记录，再确定下一步。';
  let sections: Section[] = [
    { heading: '当前材料', body: material ? concise(material.excerpt, 420) || material.title : '当前未引用资料。你可以先选中 Hub 里的内容，再把它带入讨论。', sourceIds: material ? [material.id] : [] },
    { heading: '下一步', body: '先明确这次要解决的问题，再把材料里的依据、待确认条件和一个可执行动作记在一起。' },
  ];
  if (/联网|上网|网络搜索|搜索网页|查网页|浏览网页/.test(question)) {
    text = '这个演示使用已带入的示例资料，不连接互联网或真实模型。';
    sections[1] = { heading: '可以继续', body: '查看引用的原文，整理核对问题，或把当前讨论保存为 Hub 原型里的笔记和任务。' };
  } else if (material?.workId === 'sample-work-a' || material?.workId === 'sample-work-b' || material?.workId?.startsWith('demo-work-') || material?.workId?.startsWith('public-work-')) {
    text = '这条发现的内容、依据和已保存反馈已带入原工作。';
    sections = [
      { heading: '带入的发现与反馈', body: concise(material.excerpt, 1600), sourceIds: [material.id] },
      { heading: '接下来核对什么', body: '对照引用原文和用户补充，分别确认记录事实、适用条件以及尚未验证的部分。用户反馈保留为补充，不改写原始记录。' },
      { heading: '如何更新这条发现', body: '在原工作获得新的成果后，回到发现选择「更新这条发现」，明确选择对应结论并查看前后变化。确认后才产生新修订，原来的处理状态和反馈会保留。' },
    ];
  } else if (material?.id === 'mapping-change' && /变化|变更|旧|新|版本|映射|影响|Cav|wire/i.test(question)) {
    text = '示例里的变化是 Cav 的保留方式。先核对版本，再决定验证清单需要怎样调整。';
    sections[1] = {
      heading: '核对新旧映射',
      body: '旧快照暂按纯数字保存 Cav；新的样例记录要求保留字母与前导零。\n1. 检查当前清单引用的是哪一版快照。\n2. 核对 A01、01 等字段是否应原样保留。\n3. 确认实际程序和清单是否已经同步修订。\n两份笔记不能证明程序有错，也不能证明新规则适用于所有图纸。',
    };
  } else if (isDxf && /清单|下一步|验证|行动|步骤|检查|评审/.test(question)) {
    text = '可以把这次工作收小到一份图纸的人工对照。';
    sections[1] = {
      heading: '小样例验证清单',
      body: '1. 记录图纸的车型、版本和表格样式。\n2. 人工标记五条记录，保留行号与原始位置。\n3. 逐项核对 CIRCUIT NBR、Cav 和 wire 的含义。\n4. 检查字母、前导零、空值、重复标识与跨行文本。\n5. 分别记录已核对、待解释和提取失败，再决定是否扩大范围。\n这些是演示检查项，尚未验证任何实际图纸。',
    };
  } else if (isAssembly && /车型|版本|卡扣|装配|试装|适用条件|下一步|清单|核对|提纲/.test(question)) {
    text = '先对齐两份试装记录的对象和条件，再讨论顺序差异。';
    sections[1] = {
      heading: '试装复核提纲',
      body: '1. 核对车型、左右门位置与零件组合。\n2. 补齐支架和饰板版本，以及记录时间。\n3. 对齐卡扣编号、照片视角与固定位置。\n4. 确认安装空间和当时的操作限制。\n阅读笔记可以帮助准备问题，不能替代当前车型的验证。顺序不同本身不足以判断操作对错。',
    };
  } else if (/任务|行动|下一步|计划/.test(question)) {
    text = '可以从' + subject + '里提取一个足够小的下一步。';
    sections[1] = { heading: '建议的任务草稿', body: '核对' + (material ? '这份材料' : '当前问题') + '的目标和适用条件，列出仍缺少的信息；完成后把结论补回对应笔记。你可以在保存前修改标题与内容。' };
  } else if (/待确认|问题|风险|疑问/.test(question)) {
    sections[1] = { heading: '建议先核对', body: '这份内容是否为最新版本？结论适用于哪些条件？还需要哪一份原始资料才能确认？这些问题可以整理为核对任务。' };
  } else if (/复盘|回顾|决策|日志/.test(question)) {
    sections[1] = { heading: '回顾框架', body: '发生了什么 → 当时依据什么做判断 → 后来有什么变化 → 下一次准备怎样调整。把事实和自己的解释分别写清楚。' };
  } else if (/笔记|整理|概括|总结/.test(question)) {
    sections[1] = { heading: '笔记结构', body: '保留这份材料的核心问题、依据和待确认项，再写下一个下一步。原始材料与整理后的结论保持关联，方便以后继续。' };
  }
  if (request.taskMode === 'extended') sections.push({ heading: '扩展核对范围 · 演示', body: '把同一工作里的资料放在一起，记录每一项判断的来源、适用对象与版本；证据不完整的部分继续保留为问题。' });
  if (request.thinking === 'high') sections.push({ heading: '继续检查的条件 · 演示', body: '相似标题不一定指向同一个对象；来源变更后需要重新核对。以上内容没有代替实际试验、任务验收或你的决定。' });
  if (request.resources?.skills.length) sections.push({ heading: '指定技能 · 演示', body: request.resources.skills.join('、') + '。仅展示指定方法，未加载本地技能执行。' });
  sections.push(...requestDetails(request));
  return { id: request.id + '-reply', role: 'assistant', text, sections, context: material, model: request.model };
}

function replyCitations(message: Pick<Message, 'context' | 'sections'>) {
  const context = message.context;
  const evidence = context?.evidence || [];
  const sources = new Map(evidence.map(item => [item.id, item]));
  if (context && !sources.has(context.id)) sources.set(context.id, context);
  const sections = (message.sections || []).map((section, index) => {
    let ids = section.sourceIds;
    if (!ids) {
      // Old replies only identify exact excerpts by their position, heading and text.
      const item = evidence[index];
      if (item?.excerpt && section.heading === (index + 1) + '. ' + item.title && section.body === concise(item.excerpt, 420)) ids = [item.id];
      else if (context && section.heading === '当前材料' && section.body === (concise(context.excerpt, 420) || context.title)) ids = [context.id];
      else if (context && section.heading === '带入的发现与反馈' && section.body === concise(context.excerpt, 1600)) ids = [context.id];
    }
    return [...new Set(ids || [])].flatMap(id => sources.get(id) || []);
  });
  const ordered = [...new Set(sections.flat().map(item => item.id))];
  const numbers = new Map(ordered.map((id, index) => [id, index + 1]));
  return { sections, numbers, unplaced: [...new Map(evidence.filter(item => !numbers.has(item.id)).map(item => [item.id, item])).values()] };
}

function reducer(state: Session, action: Action): Session {
  if (action.type === 'tag-turn') return { ...state, messages: [...state.messages, userMessage(action.request), action.reply].slice(-50) };
  if (action.type === 'send') {
    if (state.active) return { ...state, queue: [...state.queue, action.request] };
    return { ...state, messages: [...state.messages, userMessage(action.request)].slice(-50), active: { ...action.request, status: 'running', revision: 0 }, frozen: false };
  }
  if (action.type === 'append') {
    if (!state.active) return state;
    return {
      ...state,
      messages: [...state.messages, { id: action.id, role: 'user' as const, text: action.text, context: state.active.context, attachmentNames: action.attachmentNames }].slice(-50),
      active: {
        ...state.active, additions: [...state.active.additions, action.text],
        attachmentNames: [...new Set([...state.active.attachmentNames, ...action.attachmentNames])].slice(0, 8),
        revision: state.active.revision + 1,
      },
    };
  }
  if (action.type === 'stop') return state.active ? { ...state, active: { ...state.active, status: 'paused' }, frozen: true } : state;
  if (action.type === 'discard-active') return { ...state, active: null, frozen: true };
  if (action.type === 'remove') return { ...state, queue: state.queue.filter(item => item.id !== action.id) };
  if (action.type === 'continue') {
    if (state.active) return { ...state, active: { ...state.active, status: 'running', revision: state.active.revision + 1 }, frozen: false };
    if (!state.queue.length) return state;
    const [next, ...queue] = state.queue;
    return { ...state, queue, active: { ...next, status: 'running', revision: 0 }, frozen: false, messages: [...state.messages, userMessage(next)].slice(-50) };
  }
  if (action.type === 'complete') {
    if (!state.active || state.active.id !== action.id || state.active.status !== 'running') return state;
    const messages = [...state.messages, { ...demoReply(state.active), processWebEnabled: state.active.webSearch !== 'disabled' && state.active.researchPolicy !== 'materials-only' && state.active.model !== 'deepseek' }].slice(-50);
    if (state.queue.length && !state.frozen) {
      const [next, ...queue] = state.queue;
      return { ...state, messages: [...messages, userMessage(next)].slice(-50), active: { ...next, status: 'running', revision: 0 }, queue };
    }
    return { ...state, messages, active: null };
  }
  return state;
}

// A single dock is shared by the whole Hub. Work-linked findings have independent
// conversations; regular reading keeps the existing general conversation.
export default function Assistant(props: AssistantProps) {
  const conversations = useRef<Record<string, Conversation>>({});
  const [ready, setReady] = useState(false);
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [pins, setPins] = useState<WorkPins>(() => readWorkPins(null));
  useEffect(() => {
    try { setTopics(readTopics(JSON.parse(localStorage.getItem(topicStorageKey) || '[]'))); } catch {}
    try { setPins(readWorkPins(JSON.parse(localStorage.getItem(workPinsKey) || 'null'))); } catch {}
  }, []);
  function togglePin(kind: keyof WorkPins, id: string) {
    const current = pins[kind];
    const next = { ...pins, [kind]: current.includes(id) ? current.filter(value => value !== id) : [...current, id] };
    try { localStorage.setItem(workPinsKey, JSON.stringify(next)); }
    catch { props.notify('浏览器未能保存置顶，请检查存储权限'); return; }
    setPins(next);
  }
  function saveTopic(config: Omit<ResearchTopic, 'id'>, updateId?: string) {
    if (updateId && !topics.some(item => item.id === updateId)) { props.notify('找不到原专题，未保存更改'); return false; }
    if (!updateId && topics.length >= 30) { props.notify('原型最多保存 30 个专题，已有专题已保留'); return false; }
    const next = updateId ? topics.map(item => item.id === updateId ? { ...config, id: item.id } : item) : [{ ...config, id: uniqueId() }, ...topics];
    try { localStorage.setItem(topicStorageKey, JSON.stringify(next)); }
    catch { props.notify('浏览器未能保存专题，请检查存储权限后重试'); return false; }
    setTopics(next); props.notify(updateId ? '专题范围已更新' : '专题已保存，可从顶部的专题列表打开'); return true;
  }
  const writable = useRef(true);
  const [storageError, setStorageError] = useState('');
  const [, setRevision] = useState(0);
  const historyMeta = useRef<Record<string, { pinned: boolean; archived: boolean; deleted?: boolean }>>({});
  const [selection, setSelection] = useState<{ route: string; id: string; fresh: boolean; entry?: AssistantContext | null } | null>(null);
  const [undo, setUndo] = useState<{ id: string; previous: { pinned: boolean; archived: boolean; deleted?: boolean } } | null>(null);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      const saved = plain(JSON.parse(stored || 'null'));
      const workspaces = plain(saved?.workspaces);
      if (saved?.version === 2 && workspaces) {
        conversations.current = Object.fromEntries(Object.entries(workspaces).map(([key, value]) => [key, readConversation(value)]));
        const meta = plain(saved.history) || {};
        historyMeta.current = Object.fromEntries(Object.entries(meta).map(([key, value]) => { const item = plain(value); return [key, { pinned: item?.pinned === true, archived: item?.archived === true, deleted: item?.deleted === true }]; }));
      } else {
        if (stored !== null) { writable.current = false; setStorageError('已有对话快照无法识别，原记录已保留；当前对话仅暂存在本页。'); }
        const legacy = JSON.parse(sessionStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
        if (legacy) conversations.current.general = readConversation(legacy);
      }
    } catch { writable.current = false; setStorageError('无法读取已有对话，原快照未覆盖；当前对话仅暂存在本页。'); }
    setReady(true);
  }, []);

  const persist = useCallback((key: string, value: Conversation) => {
    conversations.current[key] = { ...value, updatedAt: Date.now() };
    if (writable.current) {
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, workspaces: conversations.current, history: historyMeta.current })); setStorageError(''); }
      catch { setStorageError('浏览器未能保存对话，当前内容仍在本页；刷新可能丢失本轮改动。'); }
    }
    setRevision(value => value + 1);
  }, []);

  if (!ready) return null;
  const route = props.sourceDemo ? 'demo:source-preview' : props.context?.workId ? 'work:' + props.context.workId : 'general';
  const selected = selection?.route === route ? selection : null;
  const workKey = selected?.id || route;
  let initial = conversations.current[workKey];
  if (!initial && workKey === 'demo:source-preview') {
    const pages = ['migrated-assembly-craft', 'migrated-assembly-obsidian'].flatMap(id => props.catalog?.find(page => page.id === id) || []);
    if (pages.length === 2 && pages.every(props.canUseContext || allowContext)) {
      const [design, field] = pages;
      initial = readConversation({
        title: '示例 · 卡扣试装核对',
        resources: { pages },
        session: { messages: [
          { id: 'source-demo-question', role: 'user', text: '评审稿和现场的卡扣安装顺序相反，是现场装错了吗？' },
          { id: 'source-demo-answer', role: 'assistant',
            text: '目前不能判定现场装错。两份记录的安装顺序确实相反，但采用的零件条件可能不同。',
            context: { ...design, evidence: [design, field] },
            sections: [
              { heading: '设计评审稿', body: '建议先装卡扣 1，再装卡扣 2；对应支架 V2 和饰板方案 A。', sourceIds: [design.id] },
              { heading: '现场试装记录', body: '实际先装卡扣 2，再装卡扣 1；支架暂记为 V3，饰板方案未记录。', sourceIds: [field.id] },
              { heading: '下一步', body: '打开两份资料，核对版本、卡扣编号和照片视角。确认是同一套零件条件后，再比较安装顺序。' },
            ],
          },
        ] },
      });
    }
  }
  initial ??= readConversation(null);
  const history: HistoryItem[] = Object.entries(conversations.current).filter(([id, value]) => !historyMeta.current[id]?.deleted && (value.session.messages.length || value.session.active)).map(([id, value]) => ({ id, updatedAt: value.updatedAt, title: value.title, pinned: historyMeta.current[id]?.pinned || false, archived: historyMeta.current[id]?.archived || false, blocked: value.contexts.some(context => !(props.canUseContext || allowContext)(context)) || value.session.messages.some(message => !(props.canUseContext || allowContext)(message.context)) || value.resources.pages.some(context => !(props.canUseContext || allowContext)(context)) })).reverse();
  const currentContext = selected ? (selected.fresh ? selected.entry || null : initial.contexts[0] || null) : initial.session.messages.length ? initial.contexts[0] || null : props.context;
  return <>{props.open && storageError && <p className="ha-storage-error" role="status">{storageError}</p>}<AssistantConversation key={workKey} {...props} context={currentContext} browsingContext={props.context} workKey={workKey} initial={initial} onPersist={persist}
    topics={topics} pins={pins} onPin={togglePin} onSaveTopic={saveTopic}
    history={history} onNewWithContext={() => setSelection({ route, id: 'chat:' + uniqueId(), fresh: true, entry: props.context })} onNew={() => setSelection({ route, id: 'chat:' + uniqueId(), fresh: true })}
    onSelect={id => setSelection({ route, id, fresh: false })}
    onHistoryChange={(id, change) => { const previous = historyMeta.current[id] || { pinned: false, archived: false }; setUndo({ id, previous }); const field = change === 'pin' ? 'pinned' : change === 'delete' ? 'deleted' : 'archived'; historyMeta.current[id] = { ...previous, [field]: !previous[field] }; if (change === 'delete' && id === workKey) setSelection({ route, id: 'chat:' + uniqueId(), fresh: true }); persist(workKey, conversations.current[workKey] || initial); }} />
    {props.open && undo && <div className="ha-history-undo" role="status"><span>对话操作已保存</span><button type="button" onClick={() => { historyMeta.current[undo.id] = undo.previous; setUndo(null); persist(workKey, conversations.current[workKey] || initial); }}>撤销</button><button type="button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}>×</button></div>}
  </>;
}

function AssistantConversation({
  activityDemo, onCloseActivityDemo,
  open, expanded, context, canUseContext = allowContext, onClose, onExpand, onOpenSource, onCreateDraft, notify, workKey, initial, onPersist, history, onNew, onSelect, onHistoryChange, catalog = [], browsingContext, onNewWithContext, currentPageId, onInsertPage, topics, pins, onPin, onSaveTopic, onOpenTagQueue, tagEntry, onTagEntryHandled, tagModel,
}: AssistantProps & { topics: ResearchTopic[]; pins: WorkPins; onPin: (kind: keyof WorkPins, id: string) => void; onSaveTopic: (config: Omit<ResearchTopic, 'id'>, updateId?: string) => boolean; workKey: string; initial: Conversation; onPersist: (key: string, conversation: Conversation) => void; browsingContext: AssistantContext | null; onNewWithContext: () => void; history: HistoryItem[]; onNew: () => void; onSelect: (id: string) => void; onHistoryChange: (id: string, change: 'pin' | 'archive' | 'delete') => void }) {
  const [session, dispatch] = useReducer(reducer, initial.session);
  const [input, setInput] = useState(initial.tagIntent ? cleanTagStarter(initial.input) : initial.input);
  const [tagMode, setTagMode] = useState(initial.tagMode);
  const [goalMode, setGoalMode] = useState(false);
  const [tag, setTag] = useState(initial.tag);
  const currentTag = tagModel.tags.includes(tag) ? tag : '';
  const [tagRefs,setTagRefs]=useState(initial.tagRefs.length ? initial.tagRefs : initial.tag ? [initial.tag] : []);
  const [tagIntent,setTagIntent]=useState<TagTask['intent'] | null>(initial.tagIntent);
  const [tagOther,setTagOther]=useState(initial.tagOther);
  const [tagPickerRole,setTagPickerRole]=useState<'references'|'target'|'other'>('references');
  const [tagError,setTagError]=useState('');
  const [tagMatchAll,setTagMatchAll]=useState(false);
  const [tagPageIds,setTagPageIds]=useState<string[]>([]);
  const handledTagEntry = useRef<typeof tagEntry>(null);
  const [inputContext, setInputContext] = useState<AssistantContext | null>(initial.inputContext);
  const [settings, setSettings] = useState<Settings>(() => readSettings(initial));
  const [omittedId, setOmittedId] = useState<string | null>(initial.omittedId);
  const [contexts, setContexts] = useState(() => includeContext(initial.contexts, context));
  const [attachmentNames, setAttachmentNames] = useState(initial.attachmentNames);
  const [resources, setResources] = useState(initial.resources || emptyResources());
  const [activeTopic, setActiveTopic] = useState(initial.activeTopic);
  const [dropReady, setDropReady] = useState(false);
  const [reading, setReading] = useState(false), [copied, setCopied] = useState<string | null>(null), [jump, setJump] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [menu, setMenu] = useState<AssistantMenu>(null);
  const [topicEdit, setTopicEdit] = useState<{ topic: ResearchTopic; resources: ResourceDraft; policy: ResearchPolicy } | null>(null);
  const [topicReview, setTopicReview] = useState<{ id: string; from: 'mode' | 'topics' } | null>(null);
  const menuReturn = useRef<HTMLElement | null>(null);
  function changeMenu(value: AssistantMenu) {
    if (value !== 'materials') setTopicEdit(null);
    if (value) {
      if (!menu) menuReturn.current = document.activeElement as HTMLElement;
      setSourcesOpen(false); setContextOpen(false);
    }
    setMenu(value);
    if (!value) requestAnimationFrame(() => { if (menuReturn.current?.isConnected) menuReturn.current.focus({ preventScroll: true }); });
  }
  const panel = useRef<HTMLElement>(null);
  const [panelSize, setPanelSize] = useState({ width: 480, height: 0 });
  useEffect(() => {
    const root = panel.current?.closest<HTMLElement>('.hub-app');
    root?.style.setProperty('--ha-dock-width', panelSize.width + 'px');
    return () => { root?.style.removeProperty('--ha-dock-width'); };
  }, [open, panelSize.width]);
  const dragging = useRef<{ axis: 'width' | 'height'; pointer: number; start: number; size: number } | null>(null);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem('hub-proto-assistant-size-v1') || 'null'); if (Number.isFinite(saved?.width) && saved.width >= 0 && Number.isFinite(saved?.height) && saved.height >= 0) setPanelSize(saved); } catch { /* Use local-client defaults. */ }
  }, []);
  function savePanelSize(next: { width: number; height: number }) {
    setPanelSize(next);
    try { localStorage.setItem('hub-proto-assistant-size-v1', JSON.stringify(next)); } catch { /* Resizing still works in memory. */ }
  }
  const resize = (axis: 'width' | 'height') => ({
    onPointerDown: (event: import('react').PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !panel.current) return;
      event.preventDefault();
      dragging.current = { axis, pointer: event.pointerId, start: axis === 'width' ? event.clientX : event.clientY, size: panel.current.getBoundingClientRect()[axis] };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: import('react').PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (!drag || drag.pointer !== event.pointerId) return;
      const next = drag.size + drag.start - (axis === 'width' ? event.clientX : event.clientY);
      savePanelSize({ ...panelSize, [axis]: clampPanelSize(next, axis === 'width' ? window.innerWidth : window.innerHeight, axis === 'width' ? 0 : 320, axis === 'width' ? 1200 : Infinity) });
    },
    onPointerUp: () => { dragging.current = null; },
    onPointerCancel: () => { dragging.current = null; },
    onDoubleClick: () => savePanelSize({ ...panelSize, [axis]: axis === 'width' ? 480 : 0 }),
    onKeyDown: (event: import('react').KeyboardEvent<HTMLDivElement>) => {
      const grow = axis === 'width' ? 'ArrowLeft' : 'ArrowUp', shrink = axis === 'width' ? 'ArrowRight' : 'ArrowDown';
      if (![grow, shrink, 'Home'].includes(event.key)) return;
      event.preventDefault();
      const size = panel.current?.getBoundingClientRect()[axis] || 480;
      savePanelSize({ ...panelSize, [axis]: event.key === 'Home' ? (axis === 'width' ? 480 : 0) : clampPanelSize(size + (event.key === grow ? 20 : -20), axis === 'width' ? window.innerWidth : window.innerHeight, axis === 'width' ? 0 : 320, axis === 'width' ? 1200 : Infinity) });
    },
  });
  const [insertion, setInsertion] = useState<{ body: string; source: AssistantContext | null } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stage, setStage] = useState(0);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 2000); return () => clearTimeout(timer); }, [copied]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const callback = useRef({ onClose, draft, contextOpen, sourcesOpen, menu, reading });
  callback.current = { onClose, draft, contextOpen, sourcesOpen, menu, reading };
  const contextBlocked = !canUseContext(context);
  const turnResources = resourcesForTurn(resources, activeTopic);
  const useManualSources = !activeTopic || activeTopic.useManualOnce;
  const turnAttachments = useManualSources ? attachmentNames : [];
  const manualSourceCount = resources.pages.length + resources.libraryIds.length + resources.images.length + (resources.dataFiles||[]).length + Number(!!resources.url) + attachmentNames.length;
  const resourcesBlocked = turnResources.pages.some(item => !canUseContext(item));
  const scopeTooLarge = turnResources.pages.length + Number(!activeTopic && !!context && context.id !== omittedId && !turnResources.pages.some(item => item.id === context.id)) > 31 || turnResources.libraryIds.length > 20;
  const inputBlocked = !!input && (!canUseContext(inputContext) || resourcesBlocked);
  const activeBlocked = !!session.active && !canUseContext(session.active.context);
  const draftBlocked = !!draft && !canUseContext(draft.context);
  const readableContexts = contexts.filter(item => canUseContext(item));
  const title = contextBlocked ? '来源不可用' : context?.workTitle || (context?.workId ? initial.title : '自由讨论');
  const material = context && !contextBlocked && !activeTopic && context.id !== omittedId && !resources.pages.some(item => item.id === context.id) ? context : null;
  const hasMaterials = Boolean(material || turnResources.pages.length || turnResources.libraryIds.length || turnResources.images.length || turnResources.dataFiles?.length || turnAttachments.length);
  const hasDraftSources = hasMaterials || !!turnResources.url;
  const needsMaterial = settings.researchPolicy === 'materials-only' && !hasMaterials;
  const effectiveWebSearch = settings.researchPolicy === 'materials-only' || settings.model === 'deepseek' ? 'disabled' : settings.webSearch;
  const evidence = collectEvidence(readableContexts);
  const running = session.active?.status === 'running';
  const paused = session.active?.status === 'paused';
  const chatTitle = contextBlocked ? '来源不可用' : (session.messages.find(item => item.role === 'user')?.text || input.trim() || '新聊天').replace(/\s+/g, ' ');
  const snapshot: Conversation = { ...settings, session, input, inputContext, attachmentNames, contexts, omittedId, title: context?.workTitle || chatTitle.slice(0, 60), resources, activeTopic, tagMode, tag, tagRefs, tagIntent, tagOther };
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const persistenceRef = useRef(onPersist);
  persistenceRef.current = onPersist;

  useEffect(() => { setContexts(previous => includeContext(previous, context)); }, [context]);

  useEffect(() => {
    onPersist(workKey, snapshotRef.current);
  }, [workKey, session, input, inputContext, settings, attachmentNames, contexts, omittedId, title, resources, activeTopic, tagMode, tag, tagRefs, tagIntent, tagOther, onPersist]);

  useEffect(() => () => {
    // Switching work preserves the request and pauses its queue. No unseen
    // simulated execution is left running in the previous conversation.
    persistenceRef.current(workKey, pauseConversation(snapshotRef.current));
  }, [workKey]);

  useEffect(() => {
    const active = session.active;
    if (!active || active.status !== 'running') return;
    if (!canUseContext(active.context)) { dispatch({ type: 'stop' }); return; }
    setStage(0);
    const duration = active.model === 'codex' && active.speed === 'fast' ? 1800 : active.taskMode === 'extended' ? 3400 : 2600;
    const first = setTimeout(() => setStage(1), Math.round(duration * .25));
    const second = setTimeout(() => setStage(2), Math.round(duration * .56));
    const finish = setTimeout(() => { if (!canUseContext(active.context)) { dispatch({ type: 'stop' }); return; } dispatch({ type: 'complete', id: active.id }); }, duration);
    return () => { clearTimeout(first); clearTimeout(second); clearTimeout(finish); };
  }, [session.active?.id, session.active?.status, session.active?.revision, canUseContext]);

  useEffect(() => {
    if (!open) return;
    const element = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => composer.current?.focus({ preventScroll: true }), 80);
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || (event.target instanceof Element && event.target.closest('.ha-token'))) return;
      event.preventDefault();
      event.stopPropagation();
      if (callback.current.draft) setDraft(null);
      else if (callback.current.menu || callback.current.sourcesOpen || callback.current.contextOpen) {
        setMenu(null); setTopicEdit(null); setSourcesOpen(false); setContextOpen(false); composer.current?.focus();
      } else if (callback.current.reading) setReading(false);
      else callback.current.onClose();
    };
    document.addEventListener('keydown', keys);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', keys);
      if (element?.isConnected) element.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = requestAnimationFrame(() => {
      if (scrollArea.current && (!session.messages.length || !jump)) scrollArea.current.scrollTop = session.messages.length ? scrollArea.current.scrollHeight : 0;
    });
    return () => cancelAnimationFrame(timer);
  }, [session.messages.length, session.active?.status, open, expanded]);

  useEffect(() => {
    if (!draft || !open) return;
    returnFocus.current = document.activeElement as HTMLElement;
    const panel = dialog.current;
    const choices = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]') || []).filter(item => item.getClientRects().length > 0);
    choices()[0]?.focus();
    const trap = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = choices();
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) return;
      if (!panel?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', trap, true); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, [!!draft, open]);

  useEffect(() => {
    if (!menu || !open) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest('.ha-menu, .ha-header, .ha-input-actions')) { setMenu(null); setTopicEdit(null); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu, open]);

  function tagTurn(text: string, explicit: AssistantContext[], catalog: AssistantContext[], prepared?: TagTask) {
    if (!tagModel.ready || session.active) { notify('请等当前任务完成后，再发送标签请求'); return false; }
    const prior = [...session.messages].reverse().find(message => message.tagTask?.tag === currentTag && canUseContext(message.context));
    const last = session.messages.at(-1), lastQuestion = session.messages.at(-2);
    const followup = /^(?:[＃#]|只看|重新|再查|继续|为什么|依据|调整|修改|改成|补充)/.test(text);
    const needsClarification = last?.tagResult && !last.tagTask && lastQuestion?.role === 'user' && /比较|对比|定义|漏标|补标/.test(lastQuestion.text);
    const question = followup && !/比较|定义|漏标|补标/.test(text)
      ? needsClarification ? lastQuestion!.text + ' ' + text : prior?.tagTask ? tagPrompt({ ...prior.tagTask, libraries: undefined }) + ' ' + text : text
      : text;
    const parsed = prepared ? {task:prepared} : parseTagRequest(question, tagModel.tags, currentTag);
    if ('task' in parsed && question !== text && !needsClarification && !parsed.task.libraries?.length && prior?.tagTask?.libraries?.length) parsed.task.libraries = prior.tagTask.libraries;
    const id = uniqueId();
    const task = 'task' in parsed ? parsed.task : undefined;
    const scopedIds = new Set([...explicit.map(item => item.id), ...catalog.filter(item => turnResources.libraryIds.includes(item.libraryId || '')).map(item => item.id)]);
    const scoped = tagModel.records.filter(item => scopedIds.has(item.id) && (!task?.libraries?.length || task.libraries.includes(tagRuleLibrary(item))));
    const rule = task?.intent === 'missing' ? tagModel.ruleFor(task.tag) : null;
    const eligible = task?.intent === 'missing' ? scoped.filter(item => rule?.libraries.includes(tagRuleLibrary(item)) || rule?.libraries.includes(item.space)) : scoped;
    const libraries = [...new Set(eligible.map(tagRuleLibrary))];
    const reply: Message = { id: id + '-reply', role: 'assistant', text: '', model: settings.model, tagTask: task };
    let result: TagResult = { ids: [], message: '' };
    if ('clarify' in parsed) result.message = parsed.clarify;
    else if (task) {
      setTag(task.tag); setTagRefs(refs=>[...new Set([...refs,task.tag,...(task.other?[task.other]:[])])]);
      if (task.intent === 'definition' && !turnResources.libraryIds.length) result = { ids: [], message: '请先在资料范围中选择分析资料库，再生成定义草稿。', next: 'scope' };
      else if (task.intent === 'missing' && !rule) result = { ids: [], message: '请先为 #' + task.tag + ' 确认标签定义，再检查漏标。', next: 'definition' };
      else if (!eligible.length && (task.intent !== 'definition' || task.libraries?.length)) {
        result = { ids: [], message: scoped.length ? '当前资料与已确认定义的适用范围没有交集。请调整资料范围。' : '当前范围没有可用于这次核对的示例资料。请在「资料范围」选中页面或资料库。', next: 'scope' };
      } else if (/^(为什么|依据)/.test(text) && prior?.tagTask?.intent === task.intent) {
        const availableIds = new Set(eligible.map(item => item.id));
        const candidates = prior.context?.evidence?.filter(item => availableIds.has(item.id)) || [];
        result.message = candidates.length ? '下面是上一条建议里仍在当前范围内的原文依据。' : '当前范围内没有可引用的上一条建议原文。';
        if (candidates.length) reply.sections = candidates.map(item => ({ heading: item.title, body: concise(item.excerpt || '', 280), sourceIds: [item.id] }));
      } else if (task.intent === 'definition' && /^(调整|修改|改成|补充)/.test(text) && prior?.tagResult?.ids.length) {
        const candidate = tagModel.suggestions.find(item => prior.tagResult!.ids.includes(item.id) && item.kind === 'definition' && item.status === 'pending' && item.evidence.every(id => eligible.some(record => record.id === id)));
        if (candidate) {
          result = { ids: [candidate.id], message: '可以在这张草稿里调整定义。确认保存前，现有定义不会改变。' };
          reply.sections = [{ heading: '这次要调整的内容', body: text }];
        } else result.message = '之前的草稿已处理，或引用超出当前范围。可以发送「起草标签定义」开始一份新草稿。';
      } else {
        result = tagModel.generate({ ...task, libraries }, eligible);
        if (task.intent === 'relation' && !result.ids.length) result.next = 'scope';
        const sources = task.intent === 'definition' ? eligible.filter(item => item.tags.includes(task.tag))
          : task.intent === 'relation' ? eligible.filter(item => item.tags.includes(task.tag) || item.tags.includes(task.other || ''))
          : eligible.filter(item => result.ids.some(id => id.startsWith('missing:' + item.id + ':')));
        if (sources.length) reply.sections = [{ heading: '原文依据', body: '可打开以下来源核对。', sourceIds: sources.slice(0, 24).map(item => item.id) }];
        if (task.intent === 'definition' && !sources.length) result.message = '已起草一份可编辑的定义。当前没有可引用的标签样本；可调整文字和适用范围，再决定是否保存。';
        if (rule) reply.sections = [{ heading: '核对依据', body: '已确认定义 v' + rule.version + ' · ' + rule.rule.include }, ...(reply.sections || [])];
      }
    }
    const evidenceIds = new Set(reply.sections?.flatMap(section => section.sourceIds || []));
    const evidence = catalog.filter(item => evidenceIds.has(item.id)).map(item => ({ id: item.id, title: item.title, source: item.libraryName, excerpt: item.excerpt.slice(0, 2400) }));
    const first = catalog.find(item => item.id === evidence[0]?.id);
    reply.context = first ? { ...first, evidence } : null;
    const selectedSkills = demoSkills.filter(([id]) => turnResources.skills.includes(id)).map(([,name]) => name);
    if (task && eligible.length) {
      const details = ['本轮范围：' + eligible.length + ' 份资料', ...(task.libraries?.length ? [task.libraries.join('、')] : [])];
      if (task.intent === 'relation' && task.other) {
        const left = eligible.filter(item => item.tags.includes(task.tag)), right = eligible.filter(item => item.tags.includes(task.other!));
        details.push('共同 ' + left.filter(item => right.includes(item)).length + ' · 仅 #' + task.tag + ' ' + left.filter(item => !right.includes(item)).length + ' · 仅 #' + task.other + ' ' + right.filter(item => !left.includes(item)).length);
      }
      reply.sections = [{ heading: '检查范围', body: details.join('。') + '。' }, ...(reply.sections || [])];
    }
    if (selectedSkills.length) reply.sections = [...(reply.sections || []), { heading: '已选技能', body: selectedSkills.join('、') + '。原型记录选择，未运行技能。' }];
    if (turnAttachments.length || turnResources.images.length || turnResources.url || publicLinkIn(text)) reply.sections = [...(reply.sections || []), { heading: '附件与链接', body: '原型保留引用，标签检查只使用所选 Hub 页面和资料库。' }];
    result.process = task ? ['核对目标：#'+task.tag+(task.other?' 与 #'+task.other:''),'核对本轮范围：'+eligible.length+' 份可用示例资料',result.ids.length?'已生成 '+result.ids.length+' 项建议，等待审核':'未生成建议：'+result.message] : ['等待补齐任务信息，尚未开始分析。'];
    reply.tagResult = result;
    reply.text = result.message;
    dispatch({ type: 'tag-turn', request: { ...settings, id, text: prepared ? tagPrompt(prepared) + (text === tagPrompt(prepared) ? '' : '\n' + text) : text, tagTask: task, context: null, additions: [], attachmentNames: turnAttachments, resources: turnResources }, reply });
    return true;
  }

  function send(text = input) {
    if (contextBlocked || inputBlocked || activeBlocked || resourcesBlocked) { notify('相关来源当前不可用，请先核对来源或移除未完成的演示请求'); return; }
    if (scopeTooLarge) { notify('本轮资料超过上限，请减少已选资料'); return; }
    if (needsMaterial && !session.active) { changeMenu('materials'); return; }
    let value = text.trim() || (tagIntent ? tagPrompt({intent:tagIntent,tag:currentTag,other:tagOther}) : tagMode ? '' : turnResources.pages.length || turnResources.libraryIds.length || material ? '请核对所选资料的要点与待确认事项。' : turnAttachments.length || turnResources.images.length || turnResources.url ? '请整理这些附件或链接仍需补充的信息。' : '');
    if (!value) return;
    const researchDemo = settings.researchPolicy !== 'material-first' || !!(turnResources.libraryIds.length || turnResources.pages.length);
    const scopedCatalog = catalog.filter(item => canUseContext(item) && !isMediaReference(item));
    const explicit = [...(material ? [material] : []), ...turnResources.pages].filter(item => !isMediaReference(item)).map(item => item.workId ? item : scopedCatalog.find(page => page.id === item.id) || item);
    const selected = researchSources(value, explicit, turnResources.libraryIds, scopedCatalog);
    const linkedEvidence = researchDemo ? [] : (material?.evidence || []).filter(item => canUseContext({ ...item, excerpt: item.excerpt || '' }));
    const sources = selected.map(item => ({ id: item.id, title: item.title, source: item.libraryName, excerpt: item.excerpt.slice(0, 2400) }));
    const requestContext = selected.length ? { ...selected[0], evidence: [...new Map([...linkedEvidence, ...sources].map(item => [item.id, item])).values()] } : null;
    if (!tagIntent && (tagMode || tagRefs.length || /[#＃]/.test(value))) {
      const inferred=parseTagRequest(value,tagModel.tags,currentTag);
      if ('task' in inferred) { setTag(inferred.task.tag);setTagIntent(inferred.task.intent);setTagOther(inferred.task.other||'');setTagRefs(refs=>[...new Set([...refs,inferred.task.tag,...(inferred.task.other?[inferred.task.other]:[])])]);notify('请核对任务与资料范围，再开始');return; }
    }
    if (tagIntent) {
      const checked=prepareTagTask(tagIntent,tagRefs,currentTag,tagOther,tagIntent==='definition'?!!turnResources.libraryIds.length:!!(explicit.length||turnResources.libraryIds.length),!!tagModel.ruleFor(currentTag));
      if ('error' in checked) {setTagError(checked.error);return;}
      if (!tagTurn(value, explicit, scopedCatalog, checked.task)) return;
      setTagIntent(null);setTagError('');
    } else if (tagMode) {
      if (!tagTurn(value, explicit, scopedCatalog)) return;
    } else if (session.active) {
      dispatch({ type: 'append', text: value, id: uniqueId(), attachmentNames: turnAttachments, url: session.active.researchPolicy === 'materials-only' ? '' : publicLinkIn(value) });
      notify(paused ? '消息已保留，点击继续后处理' : '已发送，继续处理当前任务');
    } else {
      dispatch({
        type: 'send',
        request: {
          ...settings, researchDemo, id: uniqueId(), text: (tagRefs.length ? '讨论标签：'+tagRefs.map(name=>'#'+name+(tagModel.ruleFor(name)?'（'+tagModel.ruleFor(name)!.rule.description+'）':'（尚无已确认定义）')).join('、')+'\n\n' : '')+value,
          webSearch: effectiveWebSearch,
          mcpServices: [],
          context: requestContext, resources: { ...turnResources, url: settings.researchPolicy === 'materials-only' ? '' : publicLinkIn(value) || turnResources.url },
          additions: [], attachmentNames: turnAttachments,
        },
      });
    }
    setInput(''); setInputContext(null);
    if (useManualSources) {
      setAttachmentNames([]);
      setResources(current => ({ ...current, pages: current.pages.filter(item => !isMediaReference(item)), url: '', images: [], dataFiles: [] }));
    }
    if (activeTopic?.useManualOnce) setActiveTopic({ ...activeTopic, useManualOnce: false });
    setMenu(null); setTopicEdit(null); setContextOpen(false); setSourcesOpen(false);
    composer.current?.focus();
  }

  function inputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send(input); }
  }

  function addFileNames(files: FileList | null) {
    const names = Array.from(files || [], file => (file.name || '粘贴的图片').slice(0, 500));
    if (!names.length) return;
    setAttachmentNames(previous => [...new Set([...previous, ...names])].slice(0, 8));
    notify('已添加附件名称；原型不读取或上传文件内容');
  }

  function attachFileNames(event: ChangeEvent<HTMLInputElement>) {
    addFileNames(event.target.files);
    event.target.value = '';
  }

  function pasteFiles(event: ClipboardEvent<HTMLDivElement>) {
    if (!event.clipboardData.files.length) return;
    event.preventDefault();
    if (!contextBlocked && !inputBlocked && !activeBlocked) addFileNames(event.clipboardData.files);
  }

  function acceptDrop(event: DragEvent<HTMLDivElement>) {
    const types = event.dataTransfer.types;
    if (types.includes(libraryDragType) || types.includes('Files')) {
      event.preventDefault();
      const allowed = !(contextBlocked || inputBlocked || activeBlocked || (types.includes(libraryDragType) && session.active));
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      setDropReady(allowed);
    }
  }

  function dropMaterial(event: DragEvent<HTMLDivElement>) {
    setDropReady(false);
    const transfer = event.dataTransfer;
    if (!transfer.types.includes(libraryDragType) && !transfer.files.length) return;
    event.preventDefault();
    if (contextBlocked || inputBlocked || activeBlocked) return;
    if (transfer.types.includes(libraryDragType)) {
      if (session.active) { notify('本轮结束后可添加资料库引用'); return; }
      const id = transfer.getData(libraryDragType);
      const item = catalog.find(page => page.id === id);
      if (!item || !canUseContext(item)) { notify('这份资料当前不可用'); return; }
      if (item.id === material?.id || resources.pages.some(page => page.id === id)) return;
      if (resources.pages.length >= 30) { notify('本轮已选 30 份资料，请先移除不需要的引用'); return; }
      setResources(previous => ({ ...previous, pages: [...previous.pages, item] }));
      setMenu(null);
      composer.current?.focus();
      notify(item.kind === 'image' ? '已添加资料库图片引用' : '已添加资料库引用');
      return;
    }
    addFileNames(transfer.files);
  }

  function prepare(message: Message, kind: 'note' | 'task') {
    if (!canUseContext(message.context)) { notify('相关来源当前不可用，无法准备这份草稿'); return; }
    const subject = message.context ? concise(message.context.workTitle || message.context.title, 42) : '本次讨论';
    const citations = message.context?.evidence?.map(item => item.title + (item.source ? ' · ' + item.source : '') + (item.excerpt ? '\n' + item.excerpt : '')) || [];
    const body = [
      message.text, ...(message.sections || []).map(section => section.heading + '\n' + section.body),
      ...(message.context ? ['参考材料：' + message.context.title] : []),
      ...(citations.length ? ['引用来源\n' + citations.join('\n\n')] : []),
      '演示草稿：保存到当前浏览器的 Hub 原型，可继续核对和编辑。',
    ].join('\n\n');
    setDraft({ kind, title: kind === 'note' ? subject + ' · 整理笔记' : '核对' + subject + '并记录下一步', body, context: message.context || null });
  }

  function saveDraft() {
    if (!draft || !draft.title.trim() || !draft.body.trim()) return;
    if (!canUseContext(draft.context)) { notify('相关来源当前不可用，无法保存这份草稿'); return; }
    onCreateDraft(draft.kind, draft.title.trim(), draft.body.trim(), draft.context);
    setDraft(null);
  }

  function openEvidence(id: string) {
    if (!onOpenSource) return;
    onOpenSource(id);
    onClose();
  }

  function sourceAvailable(item: AssistantEvidence) {
    return canUseContext({ id: item.id, title: item.title, excerpt: item.excerpt || '' });
  }


  function referenceButton(item: AssistantEvidence) {
    if (!sourceAvailable(item)) return <span key={item.id} className="ha-source-unavailable"><FileText size={14} />来源不可用</span>;
    return <button type="button" key={item.id} className="ha-source-row" onClick={() => openEvidence(item.id)} disabled={!onOpenSource} title={'打开原文：' + item.title}>
      <FileText size={14} /><span>{item.title}{item.source && <small>{item.source}</small>}</span><ArrowUpRight size={12} />
    </button>;
  }

  function answerBody(message: Message) {
    const citations = replyCitations(message);
    return <div className="ha-reply"><p>{message.text}</p>{message.sections?.map((section, index) => <div className="ha-reply-section" key={index}><h4>{section.heading}</h4><p>{section.body}{citations.sections[index]?.map(item => {
      const number = citations.numbers.get(item.id);
      const available = sourceAvailable(item);
      const label = '引用 ' + number + '：' + (available ? item.title : '来源当前不可用');
      return <span key={item.id} className="ha-citation-pair">
        <button type="button" className="ha-inline-citation" disabled={!available || !onOpenSource} aria-label={label} title={available ? '打开来源页面：' + item.title : label} onClick={() => openEvidence(item.id)}>{number}</button>
      </span>;
    })}</p></div>)}
      {!!citations.unplaced.length && <details className="ha-unplaced-references"><summary>相关资料（{citations.unplaced.length}）</summary>{citations.unplaced.map(referenceButton)}</details>}
    </div>;
  }

  const suggestions = hasDraftSources ? [
    { icon: FileText, label: '概括主要内容', prompt: '概括当前材料的主要内容，列出关键观点，并引用原文依据。' },
    { icon: ListPlus, label: '找出待办与待确认事项', prompt: '梳理当前材料中的行动项、未解决的问题和需要确认的事项，并给出原文依据。' },
    { icon: Link2, label: '核对依据与遗漏', prompt: '检查当前材料中哪些结论有依据、哪些还缺少证据或验证，说明依据和局限。' },
    { icon: BookOpen, label: '整理成笔记提纲', prompt: '把当前材料整理成笔记提纲，保留来源和待核对的问题。' },
  ] : [
    { icon: PencilLine, label: '整理一个想法', prompt: '帮我整理这个想法：' },
    { icon: ListPlus, label: '拆解下一步', prompt: '帮我把这件事拆成几个可执行的步骤：' },
    { icon: CircleHelp, label: '梳理待确认问题', prompt: '帮我梳理这件事还有哪些问题需要确认：' },
    { icon: BookOpen, label: '列一个笔记提纲', prompt: '围绕这个主题帮我列一个笔记提纲：' },
  ];
  const selectedMethod = demoSkills.find(item => item[0] === turnResources.skills[0]);
  const prompts = selectedMethod ? [{ icon: WandSparkles, label: selectedMethod[1], prompt: selectedMethod[2] + '，保留原文依据与待确认事项。' }, ...suggestions.slice(1)] : suggestions;
  function openTagPicker(role: 'references'|'target'|'other') {
    setTagPickerRole(role);changeMenu('tags');
  }
  function selectTag(value: string) {
    setTagError('');
    if (tagPickerRole === 'target' || tagPickerRole === 'other') {
      if (tagPickerRole === 'target') {
        if (value === tagOther) setTagOther(currentTag !== value ? currentTag : '');
        setTag(value);
      } else {
        if (value === currentTag) setTag(tagOther !== value ? tagOther : '');
        setTagOther(value);
      }
      setTagRefs(refs=>[...new Set([...refs,value])].slice(0,8));
      changeMenu(null);composer.current?.focus({preventScroll:true});return;
    }
    const next=tagRefs.includes(value)?tagRefs.filter(name=>name!==value):[...tagRefs,value].slice(0,8);
    setTagRefs(next);setTag(next.includes(value)?value:next[0]||'');
  }
  function prepareTag(intent: TagTask['intent'], target = currentTag) {
    const chosen = tagRefs.includes(target) ? target : tagRefs[0] || target;
    setTagIntent(intent);setTagError('');setTag(chosen);
    if (!tagRefs.length && chosen) setTagRefs([chosen]);
    if (intent==='relation') setTagOther(tagOther&&tagOther!==chosen&&tagRefs.includes(tagOther)?tagOther:tagRefs.find(name=>name!==chosen)||'');
    // Earlier prototypes inserted these exact empty starters; keep all actual prose.
    setInput(cleanTagStarter);
    changeMenu(null);composer.current?.focus({preventScroll:true});
  }
  useEffect(() => {
    if (!tagEntry || handledTagEntry.current === tagEntry) return;
    handledTagEntry.current = tagEntry;
    setTagMode(true);
    if (tagEntry.tag) {setTag(tagEntry.tag);setTagRefs(refs=>[...new Set([...refs,tagEntry.tag!])]);}
    if (tagEntry.task) {setTagIntent(tagEntry.task.intent);setTagOther(tagEntry.task.other||'');}
    onTagEntryHandled();
  }, [tagEntry]);
  const tagSuggestions = tagIntents.map(([intent, label], index) => {
    const Icon = [FileText, Search, Tags][index];
    return <button type="button" key={intent} onClick={() => prepareTag(intent)}><Icon size={17}/><span>{label}</span><ChevronRight className="ha-prompt-arrow" size={14}/></button>;
  });
  const linkInDraft = turnResources.url || publicLinkIn(input);
  const webStatus = settings.researchPolicy === 'materials-only'
    ? '不搜索网页，也不读取贴入的公开链接。'
    : settings.model === 'deepseek' ? 'DeepSeek 不支持联网搜索。公开链接可直接贴入；原型仅记录地址。'
    : '公开链接可直接贴入。按研究策略使用网页，原型不实际联网。';
  const accessibleCatalog = catalog.filter(item => canUseContext(item));
  const reviewedTopic = menu === 'topic-review' ? topics.find(item => item.id === topicReview?.id) : undefined;
  const scopeResources = topicEdit?.resources || resources;
  const scopeMaterial = topicEdit ? null : material;
  const scopePolicy = topicEdit?.policy || settings.researchPolicy;
  const scopeCurrent = contextBlocked ? null : browsingContext && canUseContext(browsingContext) ? browsingContext : context;
  const activeTopicName = topics.find(topic => topic.id === activeTopic?.id)?.name || activeTopic?.name;
  const topicPages = activeTopic?.scope.pages || [];
  const topicLibraries = activeTopic?.scope.libraryIds || [];
  const topicSources = activeTopic && resolveTopicSources({ pageIds: topicPages.map(item => item.id), libraryIds: topicLibraries,
    pageLabels: Object.fromEntries(topicPages.map(item => [item.id, item.title])) }, accessibleCatalog).sources;
  function applyTopic(topic: ResearchTopic) {
    if (session.active) return;
    const { sources, pages, libraryIds } = resolveTopicSources(topic, accessibleCatalog);
    if (!sources.some(item => item.available)) return;
    setActiveTopic({ id: topic.id, name: topic.name, scope: { ...emptyResources(), pages, libraryIds, skills: topic.skillIds || [] }, useManualOnce: false, policy: topic.policy,
      previousPolicy: activeTopic?.policy === settings.researchPolicy ? activeTopic.previousPolicy : settings.researchPolicy });
    setSettings(value => ({ ...value, researchPolicy: topic.policy }));
    setContextOpen(false);
    changeMenu(null);
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
    notify('已应用专题「' + topic.name + '」，继续当前对话');
  }
  function cancelActiveTopic() {
    if (!activeTopic || session.active) return;
    setSettings(value => value.researchPolicy === activeTopic.policy ? { ...value, researchPolicy: activeTopic.previousPolicy } : value);
    setActiveTopic(null);
    changeMenu(null);
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
    notify('已取消专题，手选资料、技能和草稿已保留');
  }
  function editTopicScope(topic: ResearchTopic) {
    const { pages, libraryIds } = resolveTopicSources(topic, accessibleCatalog);
    setTopicEdit({ topic, policy: topic.policy, resources: { ...emptyResources(), pages, libraryIds, skills: topic.skillIds || [] } });
    changeMenu('materials');
  }
  function saveCurrentTopic(name: string, includeSkills: boolean) {
    const selectedPages = [...new Map([...(scopeMaterial ? [scopeMaterial] : []), ...scopeResources.pages].map(item => [item.id, item])).values()];
    const { sources, pages, libraryIds } = resolveTopicSources({ pageIds: selectedPages.map(item => item.id), libraryIds: scopeResources.libraryIds }, accessibleCatalog);
    if (!sources.some(item => item.available)) { notify('请选择可复用的示例页面或资料库'); return false; }
    const saved = onSaveTopic({ name, policy: scopePolicy, pageIds: pages.map(item => item.id), libraryIds,
      skillIds: includeSkills ? scopeResources.skills : [],
      pageLabels: Object.fromEntries(sources.filter(item => item.kind === '页面' && item.available).map(item => [item.id, item.label])),
      libraryLabels: Object.fromEntries(sources.filter(item => item.kind === '资料库' && item.available).map(item => [item.id, item.label])),
    }, topicEdit?.topic.id);
    if (saved && topicEdit) changeMenu('topic-review');
    return saved;
  }

  if (!open) return null;

  return <>
    <section ref={panel} style={{ '--ha-width': panelSize.width + 'px', '--ha-height': panelSize.height ? panelSize.height + 'px' : 'clamp(460px, 80dvh, 704px)' } as import('react').CSSProperties} className={'ha-panel' + (expanded ? ' ha-expanded' : '') + (reading ? ' ha-report-reading' : '')} aria-label="Hub 助手" data-work-id={context?.workId || 'general'} inert={draft !== null || insertion !== null}>
      <div role="separator" aria-label="调整助手宽度" aria-orientation="vertical" tabIndex={0} className="ha-width-resizer" title="拖动调整宽度，双击恢复默认" {...resize('width')}/>
      {!expanded && <div role="separator" aria-label="调整助手高度" aria-orientation="horizontal" tabIndex={0} className="ha-height-resizer" title="拖动调整高度，双击恢复默认" {...resize('height')}/>}
      <AssistantHeader tagMode={tagMode} goalMode={goalMode} topicName={activeTopicName} hasSkills={!!turnResources.skills.length} modePanel={reviewedTopic ? <AssistantTopicReview topic={reviewedTopic} sources={resolveTopicSources(reviewedTopic, accessibleCatalog).sources} disabled={!!session.active}
        onBack={() => changeMenu(topicReview?.from || 'topics')} onClose={() => changeMenu(null)} onApply={() => applyTopic(reviewedTopic)} onEdit={() => editTopicScope(reviewedTopic)}/> : (menu === 'mode' || menu === 'topics') && <AssistantTaskModes tagActive={tagMode} goalActive={goalMode} onGoal={() => { setTagMode(false); setGoalMode(true); changeMenu(null); }} onTag={() => { setGoalMode(false); setTagMode(true); changeMenu(null); }} topics={topics} pins={pins} activeTopic={activeTopic?.id || null} skills={resources.skills} allTopics={menu === 'topics'} disabled={!!session.active}
        onPin={onPin} onSkill={id => { setResources(value => ({ ...value, skills: [...new Set([...value.skills, id])] })); changeMenu(null); }}
        onGeneral={() => { setGoalMode(false); setTagMode(false); changeMenu(null); }}
        onTopic={topic => { setTopicReview({ id: topic.id, from: menu === 'topics' ? 'topics' : 'mode' }); changeMenu('topic-review'); }} onAllTopics={() => changeMenu(menu === 'topics' ? 'mode' : 'topics')} onUsage={() => changeMenu('usage')} onClose={() => changeMenu(null)}/>} taskStatus={session.active?.status} menu={menu} setMenu={changeMenu} title={chatTitle} settings={settings} setSettings={value => { if (!session.active) setSettings(value); }} expanded={expanded} onExpand={onExpand} onClose={onClose} history={history} currentId={workKey} onNew={onNew} onSelect={onSelect} onHistoryChange={onHistoryChange} disabled={!!session.active} hasReport={session.messages.some(item => item.role === 'assistant' && canUseContext(item.context))} reading={reading} onReading={() => setReading(value => !value)} messageCount={session.messages.length} materialCount={turnResources.pages.length + Number(!!material)} libraryCount={turnResources.libraryIds.length} hasMaterials={hasMaterials}/>
      <div className="ha-workspace">
        <div className="ha-conversation">
          {tagIntent&&!reading&&!contextBlocked&&<TagTaskSelector intent={tagIntent} onChange={prepareTag} onCancel={()=>{setTagIntent(null);setTagError('');composer.current?.focus({preventScroll:true});}}/>}
          <div className="ha-messages" ref={scrollArea} role="log" aria-label="助手讨论记录" aria-live="polite" aria-relevant="additions" tabIndex={0} onScroll={event => { const el = event.currentTarget; setJump(el.scrollHeight - el.scrollTop - el.clientHeight > 80); }}>
            {activityDemo && <AssistantProcessDemo onClose={()=>onCloseActivityDemo?.()}/>}
            {browsingContext && context && browsingContext.id !== context.id && <div className="ha-source-notice">正在讨论「{context.title}」。当前浏览：{canUseContext(browsingContext) ? browsingContext.title : '来源不可用'}<button type="button" disabled={!!session.active || !canUseContext(browsingContext)} onClick={onNewWithContext}>用当前材料新建对话</button></div>}
            {contextBlocked && <div className="ha-access-note" role="status"><FileText size={17}/><div><strong>相关来源当前不可用</strong><p>正文、引文与依赖这些来源的历史内容已隐藏。恢复访问并核对后，可以继续。</p></div></div>}
            {!activityDemo && !session.messages.length && !contextBlocked && <div className="ha-welcome">
              <h2>{tagIntent ? tagIntents.find(([intent])=>intent===tagIntent)?.[1] : tagMode ? '你想怎么整理标签？' : hasDraftSources ? '从这份材料开始' : '有什么可以帮你？'}</h2>
              <p>{tagIntent ? tagIntent==='definition'?'根据选定资料起草定义，确认后保存。':tagIntent==='missing'?'按已确认定义查找候选，逐项核对。':'比较标签的适用边界，并核对原文依据。' : tagMode ? '选择一个场景开始，也可以直接输入 #标签名 提问。' : hasDraftSources ? '提一个问题，或选一条建议开始。' : goalMode ? '写下要完成的事和你用来判断完成的条件。' : '直接提问，也可以先选资料再讨论。'}</p>
              {!tagIntent&&<div className="ha-prompts" role="group" aria-label="建议">
                <h3>建议</h3>
                {tagMode ? tagSuggestions : prompts.map(({ icon: Icon, label, prompt }) => <button type="button" key={label} onClick={() => { setInput(value => value.trim() ? (value + '\n\n' + prompt).slice(0, 8000) : prompt); setInputContext(value => value || material); composer.current?.focus(); }}><Icon size={17} aria-hidden="true"/><span>{label}</span><ChevronRight className="ha-prompt-arrow" size={14} aria-hidden="true"/></button>)}
              </div>}
            </div>}

            {session.messages.map(message => !canUseContext(message.context) ? <article key={message.id} className="ha-message ha-message-unavailable"><FileText size={14}/><span>这段记录的来源当前不可用，内容已隐藏。</span></article> : <article key={message.id} data-latest-answer={message.id === session.messages.filter(item => item.role === 'assistant' && canUseContext(item.context)).at(-1)?.id || undefined} className={'ha-message ha-' + message.role}>
              {message.role === 'user' ? <>
                <div className="ha-user-bubble"><div>{message.text}</div><AssistantTokens context={message.context} resources={message.resources||emptyResources()} canShowPage={canUseContext} onOpenSource={onOpenSource}/></div>
                {!session.active&&<button className="ha-edit-message" type="button" onClick={()=>{if(input.trim()){notify('请先发送或保留当前草稿，再编辑这条消息');return;}setInput(message.text);setInputContext(message.context||null);setResources({...message.resources||emptyResources(),pages:[...new Map([...(message.context?[message.context]:[]),...(message.resources?.pages||[])].map(page=>[page.id,page])).values()]});setAttachmentNames(message.attachmentNames||[]);setOmittedId(context?.id||null);composer.current?.focus();}}>编辑</button>}
                {!!message.attachmentNames?.length && <div className="ha-message-files">{message.attachmentNames.map(name => <span key={name}><Paperclip size={10} />{name}</span>)}</div>}
              </> : <>
                {!message.tagTask && !message.tagResult && <AssistantProcess webEnabled={message.processWebEnabled === true}/>}
                {answerBody(message)}
                {message.tagResult && <>
                  {message.tagResult.next && <div className="ha-message-actions">
                    {message.tagResult.next === 'scope' && <button type="button" onClick={() => changeMenu('materials')}>调整资料范围</button>}
                    {message.tagResult.next === 'definition' && message.tagTask && <button type="button" onClick={() => { setTagMode(true); setTag(message.tagTask!.tag); setTagRefs(refs=>[...new Set([...refs,message.tagTask!.tag])]); prepareTag('definition'); }}>先起草定义</button>}
                  </div>}
                  {message.tagResult.ids.map(id => tagModel.suggestions.find(item => item.id === id)).map(item => item && <TagReviewCard key={item.id} item={item} model={tagModel} onOpenQueue={onOpenTagQueue}/>)}
                  {!!message.tagResult.process?.length&&<AssistantProcess steps={message.tagResult.process}/>}
                </>}
                {message.tagTask && !message.tagResult && <div className="ha-message-actions"><button type="button" onClick={() => { setTagMode(true); setTag(message.tagTask!.tag); setTagRefs(refs=>[...new Set([...refs,message.tagTask!.tag])]); prepareTag(message.tagTask!.intent); }}>在标签助手继续</button></div>}
                {!message.tagTask && !message.tagResult && <>
                <div className="ha-message-actions"><button type="button" className="ha-copy-answer" aria-label={copied === message.id ? '已复制回答' : '复制回答'} title={copied === message.id ? '已复制' : '复制回答'} onClick={async () => { try { await navigator.clipboard.writeText([message.text, ...(message.sections || []).map(item => item.heading + '\n' + item.body)].join('\n\n')); setCopied(message.id); } catch { notify('复制失败，请重试或选择正文复制。'); } }}>{copied === message.id ? <Check size={16}/> : <Copy size={16}/>}</button>{onInsertPage && <button type="button" onClick={() => setInsertion({ body: [message.text, ...(message.sections || []).map(item => item.heading + '\n' + item.body)].join('\n\n'), source: message.context || null })}><FilePlus2 size={14}/>插入页面</button>}<button type="button" title="将回答另存为独立笔记" onClick={() => prepare(message, 'note')}><PencilLine size={14}/>新建笔记</button><button type="button" title="将回答转为可编辑的待办草稿" onClick={() => prepare(message, 'task')}><ListPlus size={14}/>创建任务</button></div></>}
              </>}
            </article>)}

            {tagMode && !tagIntent && !reading && !!session.messages.length && !contextBlocked && <details className="ha-tag-prompts"><summary>标签助手建议</summary><div className="ha-prompts">{tagSuggestions}</div></details>}
            {session.active && running && !activeBlocked && <div className="ha-current-action" role="status"><span className="ha-active-ink">{['正在思考', '正在整理示例材料', '正在准备回答'][stage]}</span></div>}
            {session.active && (paused || activeBlocked) && <div className={'ha-run-status'  + (paused ? ' ha-is-paused' : '')} role="status">
              <Square size={13}/>
              <div><strong>{activeBlocked ? '来源不可用 · 已暂停' : '已暂停'}</strong><small>{activeBlocked ? '恢复来源后再核对，或移除本次演示请求' : '当前输入和队列已保留'}</small></div>
              {activeBlocked ? <button type="button" onClick={() => { dispatch({ type: 'discard-active' }); notify('未完成的演示请求已移除，历史记录保留'); }}><X size={12}/>移除请求</button> : <button type="button" onClick={() => dispatch({ type: paused ? 'continue' : 'stop' })}>{paused ? <><Play size={12} />继续</> : <><Square size={11} />停止</>}</button>}
            </div>}
          </div>

          {jump && <button type="button" className="ha-jump-latest" onClick={() => { if (scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight; setJump(false); }}>回到最新消息 ↓</button>}
          <div className="ha-composer-area">
            {session.queue.length > 0 && <div className="ha-queue"><div className="ha-queue-heading"><CornerDownRight size={12} /><span>下一条 · {session.queue.length}</span>{paused && <small>已暂停</small>}</div>{session.queue.map(item => <div className="ha-queued" key={item.id}><span>{canUseContext(item.context) ? item.text : '来源不可用 · 内容已隐藏'}</span><button type="button" className="ha-icon" onClick={() => dispatch({ type: 'remove', id: item.id })} aria-label={canUseContext(item.context) ? '移出队列：' + item.text : '移除来源不可用的请求'} title="移出队列"><X size={12} /></button></div>)}</div>}
            {!session.active && session.queue.length > 0 && <button type="button" className="ha-resume-queue" disabled={!canUseContext(session.queue[0].context)} onClick={() => { if (canUseContext(session.queue[0].context)) dispatch({ type: 'continue' }); }}><Play size={12} />继续队列</button>}



            <div className="ha-composer" data-drop-ready={dropReady || undefined} onPaste={pasteFiles} onDragOver={acceptDrop}
              onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropReady(false); }} onDrop={dropMaterial}>
              <div className="ha-composer-context">
                {!tagIntent&&tagRefs.map(name=><TagContext key={name} tag={name} open={menu==='tags'&&tag===name} onOpen={()=>{setTag(name);if(menu==='tags'&&tag===name)changeMenu(null);else openTagPicker('references');}} onRemove={()=>{setTagRefs(refs=>refs.filter(value=>value!==name));if(tag===name)setTag(tagRefs.find(value=>value!==name)||'');setTagError('');}}/> )}
                {tagMode&&!tagIntent&&!tagRefs.length&&<TagContext tag="" open={menu==='tags'} onOpen={()=>openTagPicker('references')} onRemove={()=>{}}/>}
              {activeTopic && topicSources && <ActiveTopicChip key={activeTopic.id} name={activeTopicName || activeTopic.name} sources={topicSources} pages={topicPages.length} libraries={topicLibraries.length} skills={activeTopic.scope.skills} disabled={!!session.active} onCancel={cancelActiveTopic}
                onRemoveSource={session.active ? undefined : source => setActiveTopic(value => value && ({ ...value, scope: { ...value.scope, pages: source.kind === '页面' ? value.scope.pages.filter(page => page.id !== source.id) : value.scope.pages, libraryIds: source.kind === '资料库' ? value.scope.libraryIds.filter(id => id !== source.id) : value.scope.libraryIds } }))}
                onRemoveSkill={session.active ? undefined : id => setActiveTopic(value => value && ({ ...value, scope: { ...value.scope, skills: value.scope.skills.filter(skill => skill !== id) } }))}
                />}
              {activeTopic && manualSourceCount > 0 && <p className="ha-link-policy-note">手选资料 · {activeTopic.useManualOnce ? '下一条消息会一并使用' : '已保留，未额外纳入专题范围'}</p>}
              {scopeTooLarge && <p className="ha-link-policy-note" role="status">本轮资料超过上限，请减少已选资料。</p>}
              {resourcesBlocked && <p role="status">部分本轮资料已不可用，移除后再发送。</p>}
              <AssistantTokens resources={resources} context={material} canShowPage={canUseContext} onChange={setResources} onOpenSource={onOpenSource} onRemoveContext={()=>{setOmittedId(material!.id);composer.current?.focus();}}/>
              {!!attachmentNames.length && !inputBlocked && !contextBlocked && <div className="ha-attachment-list" aria-label="附件名称，文件内容未上传">{attachmentNames.map(name => <span key={name}><Paperclip size={10} /><span title={name}>{name}</span><button type="button" className="ha-chip-remove" aria-label={'移除附件 ' + name} onClick={() => setAttachmentNames(previous => previous.filter(item => item !== name))}><X size={10} /></button></span>)}</div>}
              </div>
              {tagIntent && <section className="ha-tag-task" aria-label="标签任务准备">
                <div className="ha-tag-task-targets">
                  <button type="button" className="ha-tag-slot" aria-label="选择目标标签" aria-expanded={menu==='tags'&&tagPickerRole==='target'} onClick={()=>openTagPicker('target')}><Tags size={15}/><span>{currentTag?'#'+currentTag:'选择标签'}</span><ChevronDown size={12}/></button>
                  {tagIntent==='relation'&&<><span className="ha-tag-versus">与</span><button type="button" className="ha-tag-slot" aria-label="选择比较标签" aria-expanded={menu==='tags'&&tagPickerRole==='other'} onClick={()=>openTagPicker('other')}><Tags size={15}/><span>{tagOther?'#'+tagOther:'选择另一个标签'}</span><ChevronDown size={12}/></button></>}
                </div>
                {tagError&&<p role="alert">{tagError}</p>}
              </section>}
              {inputBlocked && <div className="ha-input-blocked"><span>未发送的内容引用了不可用来源，暂时隐藏。</span><button type="button" onClick={()=>{setInput('');setInputContext(null);setAttachmentNames([]);}}>移除这份输入</button></div>}
              <textarea ref={composer} aria-label="给 Hub 助手的消息" value={inputBlocked || contextBlocked ? '' : input} disabled={contextBlocked || inputBlocked || activeBlocked} onChange={event => { setInput(event.target.value); setInputContext(material); }} onKeyDown={inputKey} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={contextBlocked || inputBlocked || activeBlocked ? '请先核对来源状态…' : tagIntent ? '补充要求（可选）…' : tagMode && !session.messages.length ? '例如：查找 #线束设计 的漏标' : session.messages.length ? '继续追问，或告诉我接下来做什么…' : '询问 Hub 助手…'} maxLength={8000} rows={2} />
              {needsMaterial && !session.active && <p className="ha-link-policy-note" role="status">当前只用所选资料。<button type="button" className="ha-mode-link" onClick={() => changeMenu('materials')}>添加资料或切换策略</button></p>}
              {linkInDraft && !needsMaterial && !inputBlocked && !contextBlocked && settings.researchPolicy === 'materials-only' && <p className="ha-link-policy-note" role="status">当前策略仅依据材料，链接会保留在消息中，网页不会读取。</p>}
              <div className="ha-input-actions">
                <input type="file" hidden multiple ref={fileInput} aria-label="选择附件，仅显示文件名" onChange={attachFileNames} />
                <AssistantTools menu={menu} setMenu={value=>{if(value==='tags')setTagPickerRole('references');changeMenu(value);}} settings={settings} setSettings={value => { if (!session.active) setSettings(value); }} material={material} disabled={!!session.active} resources={resources} onResources={setResources} skillPins={pins.skills} onPinSkill={id => onPin('skills', id)}
                  scopeButton={<MaterialScopeButton open={menu === 'materials'} onToggle={() => changeMenu(menu === 'materials' ? null : 'materials')} pages={new Set([...(material ? [material.id] : []), ...turnResources.pages.map(item => item.id)]).size} libraries={turnResources.libraryIds.length}/>}
                  materialPanel={menu === 'materials' && <AssistantMaterialScope catalog={accessibleCatalog} resources={scopeResources} onChange={next => {setTagError("");topicEdit ? setTopicEdit({ ...topicEdit, resources: next }) : setResources(next);}} material={scopeMaterial}
                    current={scopeCurrent} topicScope={!topicEdit && activeTopic ? activeTopic.scope : undefined}
                    manualOnce={!topicEdit && activeTopic ? { checked: activeTopic.useManualOnce, count: manualSourceCount, onChange: checked => setActiveTopic(value => value && ({ ...value, useManualOnce: checked })) } : undefined}
                    effectiveScope={topicEdit ? undefined : hasMaterials} policy={scopePolicy} onPolicy={researchPolicy => topicEdit ? setTopicEdit({ ...topicEdit, policy: researchPolicy }) : setSettings(value => ({ ...value, researchPolicy }))} disabled={!!session.active} webStatus={topicEdit ? '' : webStatus}
                    onSave={saveCurrentTopic} editingTopic={topicEdit?.topic} skillNames={scopeResources.skills.map(id => demoSkills.find(item => item[0] === id)?.[1] || id)} onDone={() => changeMenu(topicEdit ? 'topic-review' : null)} onRemoveCurrent={() => { if (material) { setOmittedId(material.id); setResources(value => ({ ...value, pages: value.pages.filter(item => item.id !== material.id) })); } }}
                    onAttachCurrent={() => { if (topicEdit && scopeCurrent) { setTopicEdit({ ...topicEdit, resources: { ...scopeResources, pages: [...scopeResources.pages, scopeCurrent] } }); } else if (activeTopic && scopeCurrent) { setResources(value => ({ ...value, pages: [...value.pages, scopeCurrent] })); } else if (browsingContext && canUseContext(browsingContext) && browsingContext.id !== context?.id) setResources(value => ({ ...value, pages: [...value.pages.filter(item => item.id !== browsingContext.id), browsingContext] })); else setOmittedId(null); }}/>} onFiles={() => fileInput.current?.click()}/>

                {menu==='tags' && <TagPicker key={tagPickerRole} tag={tagPickerRole==='other'?tagOther:currentTag} model={tagModel} onPick={selectTag} onClose={()=>changeMenu(null)} single={tagPickerRole!=='references'} title={tagPickerRole==='other'?'选择比较标签':tagPickerRole==='target'?'选择目标标签':'选择标签'} selected={tagPickerRole==='other'?[tagOther]:tagPickerRole==='target'?[currentTag]:tagRefs} onRelated={()=>{setTagPageIds([]);changeMenu('tag-materials');}} onDraft={()=>prepareTag('definition',tagPickerRole==='other'?tagOther:currentTag)}/>}
                {menu==='tag-materials'&&<section className="ha-menu ha-composer-menu ha-tag-picker" aria-label="标签关联资料"><header className="ha-menu-heading"><strong>查找关联资料</strong><button type="button" className="ha-icon" aria-label="关闭关联资料" onClick={()=>changeMenu(null)}><X size={16}/></button></header>
                  <label className="ha-tag-match">多个标签<select aria-label="标签匹配方式" value={tagMatchAll?'all':'any'} onChange={event=>{setTagMatchAll(event.target.value==='all');setTagPageIds([]);}}><option value="any">匹配任一</option><option value="all">同时包含</option></select></label>
                  <p>仅查找当前已选页面和资料库。{!turnResources.libraryIds.length&&!turnResources.pages.length&&!material&&<button type="button" onClick={()=>changeMenu('materials')}>先选择资料范围</button>}</p>
                  <div className="ha-tag-options">{accessibleCatalog.filter(page=>turnResources.libraryIds.includes(page.libraryId||'')||turnResources.pages.some(item=>item.id===page.id)||material?.id===page.id).filter(page=>{const names=tagModel.records.find(record=>record.id===page.id)?.tags||[];return tagRefs.length&&(tagMatchAll?tagRefs.every(name=>names.includes(name)):tagRefs.some(name=>names.includes(name)));}).map(page=><label className="ha-tag-match" key={page.id}><input type="checkbox" checked={tagPageIds.includes(page.id)} onChange={event=>setTagPageIds(ids=>event.target.checked?[...ids,page.id]:ids.filter(id=>id!==page.id))}/>{page.title}</label>)}</div>
                  {!tagPageIds.length&&<p>勾选要添加的结果；没有匹配项可调整标签或资料范围。</p>}
                  <button type="button" className="ha-tag-definition-action" disabled={!tagPageIds.length} onClick={()=>{const pages=[...new Map([...resources.pages,...accessibleCatalog.filter(page=>tagPageIds.includes(page.id))].map(page=>[page.id,page])).values()];if(pages.length>30){notify('最多选择 30 份资料');return;}setResources({...resources,pages});changeMenu(null);}}>添加所选 {tagPageIds.length} 份资料</button>
                </section>}
                {running && <button type="button" className="ha-send" aria-label="停止本轮" title="停止本轮" onClick={() => dispatch({ type: 'stop' })}><Square size={13} fill="currentColor"/></button>}
                {(!running || !!input.trim() || !!attachmentNames.length) && <button type="button" className="ha-send" disabled={contextBlocked || inputBlocked || activeBlocked || resourcesBlocked || scopeTooLarge || (needsMaterial && !session.active) || (!input.trim() && !tagIntent && (tagMode || !hasDraftSources)) || (tagMode && (!!session.active || !tagModel.ready))} aria-label={tagIntent ? tagIntent==='definition'?'生成草稿':tagIntent==='missing'?'开始检查':'开始比较' : '发送'} title="发送" onClick={() => send()}>{tagIntent?<span>{tagIntent==='definition'?'生成草稿':tagIntent==='missing'?'开始检查':'开始比较'}</span>:<ArrowUp size={19}/>}</button>}
              </div>
            </div>
            <div className="ha-composer-hint"><span>演示模式 · 不调用模型服务</span>{evidence.length > 0 ? <button type="button" aria-expanded={sourcesOpen} onClick={() => { setSourcesOpen(value => !value); setContextOpen(false); }}><FileText size={10} />来源 {evidence.length}<ChevronDown size={9} /></button> : <span>Ctrl+Enter 发送</span>}</div>

            {sourcesOpen && <div className="ha-sources-popover" role="region" aria-label="原工作参考资料"><header><strong>原工作参考资料</strong><button type="button" className="ha-icon" aria-label="收起参考资料" onClick={() => setSourcesOpen(false)}><X size={13} /></button></header><div>{material && referenceButton(material)}{evidence.filter(item => item.id !== material?.id).map(item => referenceButton(item))}{!material && !evidence.length && <p>当前未添加资料，可直接提问。</p>}</div><p>来源随本工作中打开的发现合并；点击可回到 Hub 原文。</p></div>}
          </div>
        </div>
      </div>
    </section>

    {insertion && onInsertPage && <AssistantInsert body={insertion.body} source={insertion.source} catalog={catalog} currentPageId={currentPageId} allowed={canUseContext} onInsert={onInsertPage} onClose={() => setInsertion(null)}/>}
    {draft && <div className="ha-draft-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}>
      <div className="ha-draft-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="ha-draft-title">
        <header className="ha-draft-header"><div><span className="ha-draft-eyebrow">保存前确认</span><h2 id="ha-draft-title">{draft.kind === 'note' ? '新建笔记' : '创建任务'}</h2></div><button type="button" className="ha-icon" aria-label="关闭草稿确认" onClick={() => setDraft(null)}><X size={18} /></button></header>
        {draftBlocked ? <div className="ha-access-note" role="status"><FileText size={17}/><div><strong>这份草稿的来源当前不可用</strong><p>正文已隐藏，暂不能保存。恢复访问并核对后再继续。</p></div></div> : <div className="ha-draft-body"><label htmlFor="ha-draft-name">标题</label><input id="ha-draft-name" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} maxLength={180} /><label htmlFor="ha-draft-content">{draft.kind === 'note' ? '笔记内容' : '任务说明'}</label><textarea id="ha-draft-content" value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} rows={10} /><p><FileText size={13} />保存到 Hub 原型的{draft.kind === 'note' ? '全部内容' : '任务'}，可继续编辑。</p></div>}
        <footer className="ha-draft-footer"><button type="button" className="ha-secondary-button" onClick={() => setDraft(null)}>继续讨论</button><button type="button" className="ha-primary-button" disabled={draftBlocked || !draft.title.trim() || !draft.body.trim()} onClick={saveDraft}><Check size={14} />{draft.kind === 'note' ? '确认保存笔记' : '确认创建任务'}</button></footer>
      </div>
    </div>}
  </>;
}
