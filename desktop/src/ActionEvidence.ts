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
export type Citation = { source: string; quote: string };
export type Claim = { text: string; source: string; quote: string; verify?: boolean; citations?: Citation[] };
export type Clue = { key: string; title: string; material: Material };
export type MeasurementConflict = {
  unit: string;
  spec: Material;
  specValue: string;
  field: Material;
  fieldValue: string;
};
export type ParsedWaitDraft = { who: string; what: string; review: string; blocking: boolean };
export type ModelMode = "harvest" | "steps" | "draft" | "report" | "followup" | "plan";
export const native = <T>(action: string, args: object = {}) =>
  invoke<T>("task_planning_source", { args: { action, ...args } });
export const todayKey = (date = new Date()) =>
  [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(
    "-",
  );
export function shiftDay(day: string, deltaDays: number) {
  const date = new Date(day + "T12:00:00");
  if (!Number.isFinite(date.getTime())) return day;
  date.setDate(date.getDate() + deltaDays);
  return todayKey(date);
}
export function nextMonday(day: string) {
  const date = new Date(day + "T12:00:00");
  if (!Number.isFinite(date.getTime())) return day;
  const diff = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + diff);
  return todayKey(date);
}
const weekdayMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
export function parseWaitFromText(text: string, day: string): ParsedWaitDraft {
  const cleaned = text.trim();
  let review = /今天/.test(cleaned) ? day : "";
  const iso = cleaned.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const cnDate = cleaned.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const weekday = cleaned.match(/(下|本|这)?(?:周|星期)([一二三四五六日天])/);
  if (iso) {
    review = iso[1];
  } else if (cnDate) {
    const year = day.slice(0, 4);
    review = `${year}-${cnDate[1].padStart(2, "0")}-${cnDate[2].padStart(2, "0")}`;
  } else if (/后天/.test(cleaned)) {
    review = shiftDay(day, 2);
  } else if (/明天/.test(cleaned)) {
    review = shiftDay(day, 1);
  } else if (weekday) {
    const base = new Date(day + "T12:00:00");
    if (Number.isFinite(base.getTime())) {
      const target = weekdayMap[weekday[2]];
      const calendarDiff = (target || 7) - (base.getDay() || 7);
      const diff = weekday[1] === "下" ? calendarDiff + 7
        : weekday[1] ? calendarDiff : (calendarDiff + 7) % 7;
      review = shiftDay(day, diff);
    }
  }
  const waitWho =
    cleaned.match(
      /(?:等|催|找|问|请)\s*([^\s，,。；;：:]{2,14}?)(?:下?(?:周|星期)[一二三四五六日天]|明天|后天|今天|月底|年底|前|回传|回复|发|给|补发|提供|确认|复核|核对|对接|沟通)/,
    )?.[1] || "";
  const blocking = /阻塞|卡住|卡在|否则(?:无法|卡)|前置|先等|待.{0,12}后再/.test(cleaned);
  let what = cleaned
    .replace(/^(?:[-*]\s*)?\[ \]\s*|^TODO[:：]?\s*/i, "")
    .replace(/(?:，|,)?\s*(?:否则|不然).+$/, "")
    .trim();
  if (waitWho) {
    const afterWho = what.split(waitWho).slice(1).join(waitWho);
    const trimmed = afterWho
      .replace(/^(?:下?(?:周|星期)[一二三四五六日天]|明天|后天|今天|月底|年底)?(?:前)?(?:回传|回复|补发|提供|发|给)?/, "")
      .trim();
    if (trimmed.length >= 2) what = trimmed;
  }
  return { who: waitWho, what: what || cleaned, review, blocking };
}
const actionWords =
  /(?:^\s*(?:[-*]\s*)?\[ \]|\bTODO\b|待确认|待办|待验证|回头.{0,18}(?:找|对|确认|看)|我来|我负责|我需要|我得|等.{1,15}回传|跟进|(?<!不)(?:得|要|记得)\s*(?:找|问|催|核对|复核|查一下|确认|对接|补发))/i;
const stop = new Set(
  "流程 开发 经验 沉淀 相关内容 参考资料 供应商 相关工作 汇总 相关 关于 完成 进行 准备 跟进 需要 确认 整理 问题 更新 工作 今天 任务 以及 一下 这个 我的 然后 的 并 与 和 后 了".split(
    " ",
  ),
);
const zhSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const numericAnchorRegexCache = new Map<string, RegExp>();
function numericAnchorRegex(anchor: string): RegExp {
  let cached = numericAnchorRegexCache.get(anchor);
  if (!cached) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cached = new RegExp(`(?<![a-z0-9]|\\d\\.)${escaped}(?![a-z0-9]|\\.\\d)`);
    if (numericAnchorRegexCache.size > 512) numericAnchorRegexCache.clear();
    numericAnchorRegexCache.set(anchor, cached);
  }
  return cached;
}
export function terms(text: string): string[] {
  const tokens: string[] = [];
  let fragment = "";
  const flush = () => {
    if (fragment.length >= 2 && !stop.has(fragment)) tokens.push(fragment);
    fragment = "";
  };
  for (const part of zhSegmenter.segment(text.toLowerCase())) {
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
    return numericAnchorRegex(anchor).test(haystack);
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
        title:
          quote
            .replace(/^\s*(?:[-*]\s*)?\[ \]\s*|^TODO[:：]?\s*/gi, "")
            .replace(/\*\*|__/g, "")
            .trim() || quote,
        material: { ...source, originId: source.id, id: key, text: quote },
      });
    }
  }
  return [...found.values()];
}
export type QueryMaterialsResult = {
  items: Material[];
  partialError: string;
};
export async function queryMaterials(
  title: string,
  scope: string[] | null,
  taskTitles: string[] = [],
  signal?: AbortSignal,
): Promise<QueryMaterialsResult> {
  if (scope?.length === 0) return { items: [], partialError: "" };
  const titleTerms = terms(title);
  const anchors = [
    ...new Set([...titleTerms.slice(0, 5), ...taskTitles.flatMap((task) => terms(task).slice(0, 2))]),
  ];
  const search = (query: string) =>
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
    });
  const byId = new Map<string, Material>();
  let failure: unknown;
  let failures = 0;
  let successes = 0;
  for (let offset = 0; offset < anchors.length; offset += 6) {
    if (signal?.aborted) return { items: [], partialError: "" };
    const batch = await Promise.allSettled(anchors.slice(offset, offset + 6).map(search));
    for (const result of batch) {
      if (result.status === "rejected") {
        failure ??= result.reason;
        failures += 1;
        continue;
      }
      successes += 1;
      for (const row of normalizeResults(result.value)) {
        if (row.provider === "dida365") continue;
        const material = documentMaterial(row);
        if (!byId.has(material.id)) byId.set(material.id, material);
      }
    }
  }
  if (!successes && failure) throw failure;
  const partialError = failures
    ? `部分跨库检索失败（${failures}/${anchors.length} 项）：${failure instanceof Error ? failure.message : String(failure)}，已保留已找到的材料。`
    : "";
  const materials = [...byId.values()];
  if (taskTitles.length) return { items: materials, partialError };
  return {
    items: materials
      .sort((a, b) => relevance(anchors, b.title + " " + b.text) - relevance(anchors, a.title + " " + a.text))
      .slice(0, 12),
    partialError,
  };
}
const evidenceNumbers = /(?:[<>≤≥]\s*)?(?:[±+-]\s*)?\d+(?:[.,]\d+)?/g;
const engineeringMeasurements =
  /(?:[<>≤≥]\s*)?(?:[±+-]\s*)?\d+(?:[.,]\d+)?\s*(?:mm|cm|km|m|[μµu]m|mil|in|ft|mpa|kpa|pa|n[·⋅]m|nm|n|kg|g|[°º]\s*[cf]|%|毫米|厘米|米|微米|摄氏度|华氏度|千帕|兆帕)(?![a-z])/gi;
const normalizeEvidence = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/−/g, "-").replace(/<=\s*/g, "≤").replace(/>=\s*/g, "≥");
const evidenceMatches = (text: string, pattern: RegExp) =>
  (text.match(pattern) || []).map((value) => value.replace(/\s+/g, ""));

const unitFromMeasurement = (token: string) => {
  const m = token.match(/[a-zμµ°º%·⋅\u4e00-\u9fff]+$/i);
  return m ? m[0].replace(/毫米/g, "mm").replace(/厘米/g, "cm").replace(/微米/g, "μm").replace(/摄氏度|℃|°c/gi, "°c") : "";
};
const numberFromMeasurement = (token: string) => {
  const m = token.match(/[+-]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};
export function detectMeasurementConflicts(recent: Material[], long: Material[]): MeasurementConflict[] {
  if (!recent.length || !long.length) return [];
  const specByUnit = new Map<string, { material: Material; raw: string; value: number }[]>();
  for (const spec of long) {
    const normalized = normalizeEvidence(spec.text);
    for (const token of evidenceMatches(normalized, engineeringMeasurements)) {
      const unit = unitFromMeasurement(token);
      const value = numberFromMeasurement(token);
      if (!unit || !Number.isFinite(value)) continue;
      const list = specByUnit.get(unit) || [];
      if (!list.some((row) => row.value === value && row.material.id === spec.id)) {
        list.push({ material: spec, raw: token, value });
        specByUnit.set(unit, list);
      }
    }
  }
  const conflicts: MeasurementConflict[] = [];
  const seen = new Set<string>();
  for (const field of recent) {
    const normalized = normalizeEvidence(field.text);
    for (const token of evidenceMatches(normalized, engineeringMeasurements)) {
      const unit = unitFromMeasurement(token);
      const value = numberFromMeasurement(token);
      if (!unit || !Number.isFinite(value)) continue;
      const specs = specByUnit.get(unit);
      if (!specs) continue;
      for (const spec of specs) {
        if (spec.value === value) continue;
        const key = `${unit}:${spec.material.id}:${field.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
          unit,
          spec: spec.material,
          specValue: spec.raw,
          field,
          fieldValue: token,
        });
        if (conflicts.length >= 3) return conflicts;
      }
    }
  }
  return conflicts;
}

export async function generate(mode: ModelMode, materials: Material[]): Promise<Claim[]> {
  const input = materials
    .slice(0, 48)
    .map((m, i) => ({ id: String(i + 1), title: m.title.slice(0, 180), text: m.text.slice(0, 900) }));
  const value = await native<{ items: Claim[] }>("workbenchModel", { mode, materials: input });
  const accepted: Claim[] = [];
  for (const item of value.items) {
    if (!item.text.trim()) continue;
    const rawCitations: Citation[] =
      Array.isArray(item.citations) && item.citations.length
        ? item.citations
        : [{ source: item.source, quote: item.quote }];
    const verifiedCitations: Citation[] = [];
    for (const cite of rawCitations) {
      const idx = input.findIndex((m) => m.id === cite.source);
      if (idx < 0 || !cite.quote?.trim() || !input[idx].text.includes(cite.quote)) continue;
      verifiedCitations.push({ source: materials[idx].id, quote: cite.quote });
    }
    if (!verifiedCitations.length) continue;
    const quotes = verifiedCitations.map((c) => normalizeEvidence(c.quote));
    const claim = normalizeEvidence(item.text);
    const unsupported =
      [evidenceNumbers, engineeringMeasurements].some((pattern) => {
        const quoted = new Set(quotes.flatMap((quote) => evidenceMatches(quote, pattern)));
        return evidenceMatches(claim, pattern).some((token) => !quoted.has(token));
      }) ||
      (/已达标|放行|符合标准|确认通过/.test(item.text) &&
        !verifiedCitations.some((c) => c.quote.includes(item.text)));
    const primary = verifiedCitations[0];
    if (accepted.some((c) => c.source === primary.source && (mode === "plan" || c.text === item.text))) continue;
    accepted.push({
      ...item,
      verify: item.verify || unsupported,
      source: primary.source,
      quote: primary.quote,
      citations: verifiedCitations.length > 1 ? verifiedCitations : undefined,
    });
  }
  if (value.items.length && !accepted.length) throw Error("生成内容未能对应原文，请重新选择材料。");
  return accepted;
}
const genericMatchTerms = new Set(
  "复核 核对 验收 验证 工位 试验 报告 结构组 供应商 检查 明天 后天 昨天 本周 下周 上周 周一 周二 周三 周四 周五 周六 周日 星期一 星期二 星期三 星期四 星期五 星期六 星期日 上午 下午 晚上 月底 年底 尽快 回头 提供 提交 回传 回复 沟通 对接 联系 补发 安排 处理 修改 补充 反馈 负责 记得 待办 待确认 待验证 查一下".split(
    " ",
  ),
);
export function matchExisting(clue: Clue, tasks: UnifiedTask[]) {
  const anchors = terms(clue.title).filter((term) => !genericMatchTerms.has(term));
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
