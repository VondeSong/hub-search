/// <reference lib="es2022.intl" />
import { invoke } from "@tauri-apps/api/core";
import type { QuickJournalItem } from "./JournalRecords";
import type { SearchResult } from "./SearchTypes";
import { normalizeResults } from "./SearchResultNormalization";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

export type Material = {
  id: string;
  title: string;
  text: string;
  date?: string;
  journalId?: string;
  originId?: string;
  result?: SearchResult;
};
export type Claim = { text: string; source: string; quote: string; verify?: boolean };
export type Clue = { key: string; title: string; material: Material };
export type ModelMode = "harvest" | "steps" | "draft" | "report" | "followup" | "plan";
export const native = <T>(action: string, args: object = {}) =>
  invoke<T>("task_planning_source", { args: { action, ...args } });
export const todayKey = (date = new Date()) =>
  [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(
    "-",
  );
const actionWords =
  /(?:^\s*(?:[-*]\s*)?\[ \]|\bTODO\b|待确认|待办|待验证|回头.{0,18}(?:找|对|确认|看)|(?:我来|我负责|我需要|我得|等.{1,15}回传|跟进))/i;
const stop = new Set(
  "流程 开发 经验 沉淀 相关内容 参考资料 供应商 相关工作 汇总 相关 关于 完成 进行 准备 跟进 需要 确认 整理 问题 更新 工作 今天 任务 以及 一下 这个 我的 然后 的 并 与 和 后 了".split(
    " ",
  ),
);
export function terms(text: string): string[] {
  const tokens: string[] = [];
  let fragment = "";
  const flush = () => {
    if (fragment.length >= 2 && !stop.has(fragment)) tokens.push(fragment);
    fragment = "";
  };
  for (const part of new Intl.Segmenter("zh", { granularity: "word" }).segment(text.toLowerCase())) {
    if (part.isWordLike && /^\p{Script=Han}$/u.test(part.segment)) {
      fragment += part.segment;
      continue;
    }
    flush();
    if (part.isWordLike && part.segment.length >= 2 && !stop.has(part.segment)) tokens.push(part.segment);
  }
  flush();
  return [...new Set(tokens)].sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)));
}
export function matchingTerms(anchors: string[], text: string) {
  const haystack = text.toLowerCase();
  return anchors.filter((anchor) => {
    if (!/\d/.test(anchor)) return haystack.includes(anchor);
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9]|\\d\\.)${escaped}(?![a-z0-9]|\\.\\d)`).test(haystack);
  });
}
export function relevance(anchors: string[], text: string) {
  return matchingTerms(anchors, text).reduce((score, term) => score + (/\d/.test(term) ? 4 : 1), 0);
}
export function documentMaterial(result: SearchResult): Material {
  return {
    id: JSON.stringify([result.libraryId, result.documentId, result.blockId || result.id]),
    title: result.documentTitle || result.title,
    text: result.snippet || result.title,
    result,
    date: result.modifiedAt
      ? todayKey(new Date(result.modifiedAt * (result.modifiedAt < 1e12 ? 1000 : 1)))
      : undefined,
  };
}
export function journalMaterial(item: QuickJournalItem): Material {
  return {
    id: JSON.stringify(["journal", item.libraryId, item.record.id]),
    journalId: item.record.id,
    title: item.record.date + " 现场日志",
    date: item.record.date,
    text: item.body || item.record.text,
  };
}
export function extractClues(materials: Material[]): Clue[] {
  const found = new Map<string, Clue>();
  for (const source of materials) {
    for (const line of source.text.split(/[\n。！？；]+/u)) {
      const quote = line.trim();
      if (quote.length < 4 || quote.length > 700 || !actionWords.test(quote) || /^\s*[-*]?\s*\[[xX]\]/.test(quote))
        continue;
      const key = JSON.stringify([source.id, quote]);
      found.set(key, {
        key,
        title: quote.replace(/^\s*(?:[-*]\s*)?\[ \]\s*|^TODO[:：]?\s*/gi, "") || quote,
        material: { ...source, originId: source.id, id: key, text: quote },
      });
    }
  }
  return [...found.values()];
}
export async function queryMaterials(title: string, scope: string[] | null): Promise<Material[]> {
  if (scope?.length === 0) return [];
  const anchors = terms(title).slice(0, 5);
  const results = await Promise.all(
    anchors.map((query) =>
      invoke<unknown>("local_search", {
        query,
        limit: 10,
        spaceIds: scope,
        folderId: null,
        updatedAfter: null,
        includeCraftPages: true,
        includeDidaTasks: false,
        includeImageOcr: true,
        includePdf: true,
        includePdfOcr: true,
        includeAttachments: true,
        includeReading: false,
        includeFlashcards: false,
        searchScope: "all",
      }),
    ),
  );
  const byId = new Map<string, Material>();
  for (const group of results)
    for (const result of normalizeResults(group)) {
      if (result.provider === "dida365") continue;
      const m = documentMaterial(result);
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
  return [...byId.values()]
    .sort((a, b) => relevance(anchors, b.title + " " + b.text) - relevance(anchors, a.title + " " + a.text))
    .slice(0, 12);
}
const evidenceNumbers = /(?:[<>≤≥]\s*)?(?:[±+-]\s*)?\d+(?:[.,]\d+)?/g;
const engineeringMeasurements =
  /(?:[<>≤≥]\s*)?(?:[±+-]\s*)?\d+(?:[.,]\d+)?\s*(?:mm|cm|km|m|[μµu]m|mil|in|ft|mpa|kpa|pa|n[·⋅]m|nm|n|kg|g|[°º]\s*[cf]|%|毫米|厘米|米|微米|摄氏度|华氏度|千帕|兆帕)(?![a-z])/gi;
const normalizeEvidence = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/−/g, "-").replace(/<=\s*/g, "≤").replace(/>=\s*/g, "≥");
const evidenceMatches = (text: string, pattern: RegExp) =>
  (text.match(pattern) || []).map((value) => value.replace(/\s+/g, ""));

export async function generate(mode: ModelMode, materials: Material[]): Promise<Claim[]> {
  const input = materials
    .slice(0, 48)
    .map((m, i) => ({ id: String(i + 1), title: m.title.slice(0, 180), text: m.text.slice(0, 900) }));
  const value = await native<{ items: Claim[] }>("workbenchModel", { mode, materials: input });
  const accepted: Claim[] = [];
  for (const item of value.items) {
    const i = input.findIndex((m) => m.id === item.source);
    if (i < 0 || !item.text.trim() || !item.quote.trim() || !input[i].text.includes(item.quote)) continue;
    const quote = normalizeEvidence(item.quote);
    const claim = normalizeEvidence(item.text);
    const unsupported =
      [evidenceNumbers, engineeringMeasurements].some((pattern) => {
        const quoted = new Set(evidenceMatches(quote, pattern));
        return evidenceMatches(claim, pattern).some((token) => !quoted.has(token));
      }) ||
      (/已达标|放行|符合标准|确认通过/.test(item.text) && !item.quote.includes(item.text));
    const source = materials[i].id;
    if (accepted.some((claim) => claim.source === source && (mode === "plan" || claim.text === item.text)))
      continue;
    accepted.push({ ...item, verify: item.verify || unsupported, source });
  }
  if (value.items.length && !accepted.length) throw Error("生成内容未能对应原文，请重新选择材料。");
  return accepted;
}
export function matchExisting(clue: Clue, tasks: UnifiedTask[]) {
  const anchors = terms(clue.title);
  return tasks
    .filter((t) => t.status === "open")
    .map((task) => ({ task, score: relevance(anchors, task.title) }))
    .filter(
      (row) =>
        row.task.title === clue.title || (row.score >= 3 && matchingTerms(anchors, row.task.title).length >= 2),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((row) => row.task);
}
