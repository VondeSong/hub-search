import type { AssistantContext } from "../Assistant";
import { sourceMeta } from "../data";
import { tagLibraryOptions, tagRuleLibrary, type TagReviewModel, type TagTask } from "../tag-assistant";
import { prepareTagTask } from "../tag-task";

export type AgentsMaterial = {
  id: string;
  name: string;
  path: string;
  text: string;
};

export type WorkspaceAgentsContext = AgentsMaterial & {
  kind: "document" | "task" | "insight" | "tag";
  evidence?: AgentsMaterial[];
  tag?: string;
  tagTask?: TagTask;
};

const contextLabels = { task: "任务分析", insight: "洞察" };
const tagRecordId = (id: string) => "tag-record:" + id;

export function discussionContext(kind: "task" | "insight", context: AssistantContext): WorkspaceAgentsContext {
  const evidence = new Map<string, AgentsMaterial>();
  for (const source of context.evidence ?? []) {
    evidence.set(source.id, {
      id: "evidence:" + source.id,
      name: source.title,
      path: source.source || "关联依据",
      text: source.excerpt || "",
    });
  }
  const work = context.workTitle ? "关联工作：" + context.workTitle : "";
  const revision = context.revision === undefined ? "" : "洞察修订 v" + context.revision;
  return {
    id: kind + ":" + context.id,
    kind,
    name: context.title,
    path: [context.path, work, revision].filter(Boolean).join(" · ") || contextLabels[kind],
    text: context.excerpt,
    evidence: [...evidence.values()],
  };
}

export function tagDiscussionContext(tag: string | undefined, task: TagTask | undefined, model: TagReviewModel): WorkspaceAgentsContext {
  const current = task?.tag || tag;
  const rule = current ? model.ruleFor(current) : null;
  const pending = current ? model.suggestions.filter(item =>
    item.status === "pending" && (item.tag === current || (item.kind === "relation" && item.other === current))
  ).length : 0;
  return {
    id: "tag:" + (current ?? "") + ":" + (task?.intent ?? "") + ":" + (task?.other ?? ""),
    kind: "tag",
    name: current ? "#" + current : "标签助手",
    path: rule ? "已确认定义 v" + rule.version + " · " + pending + " 条待处理建议" : "标签 · " + pending + " 条待处理建议",
    text: current ? [
      model.description(current),
      rule && "纳入：" + rule.rule.include,
      rule && "排除：" + rule.rule.exclude,
      rule && "定义适用范围：" + rule.libraries.join("、"),
    ].filter(Boolean).join("\n") : "",
    tag: current,
    tagTask: task,
  };
}

export function tagWorkspaceMaterials(model: TagReviewModel) {
  return model.records.map(item => ({
    id: tagRecordId(item.id),
    name: item.title,
    path: sourceMeta[item.source].name + " · " + item.space,
    text: item.excerpt,
  }));
}

export function tagWorkspaceLibraries(model: TagReviewModel, selected: string[]) {
  return tagLibraryOptions(model.records, selected).map(([id, name]) => ({
    id,
    name,
    source: "",
    count: model.records.filter(item => tagRuleLibrary(item) === id).length + " 项资料",
    color: "bg-emerald-500",
  }));
}

export function runWorkspaceTagReview(
  model: TagReviewModel,
  intent: TagTask["intent"],
  tag: string,
  other: string,
  documents: string[],
  libraries: string[],
) {
  if (!model.ready) return { ids: [], message: "标签记录正在加载，请稍后重试。" };
  const rule = model.ruleFor(tag);
  const prepared = prepareTagTask(intent, model.tags, tag, other,
    intent === "definition" ? libraries.length > 0 : documents.some(id => id.startsWith("tag-record:")) || libraries.length > 0,
    !!rule);
  if ("error" in prepared) return { ids: [], message: prepared.error };
  const scoped = model.records.filter(item => libraries.includes(tagRuleLibrary(item)) || documents.includes(tagRecordId(item.id)));
  const eligible = intent === "missing" ? scoped.filter(item => rule?.libraries.includes(tagRuleLibrary(item))) : scoped;
  if (!eligible.length && intent !== "definition") {
    return { ids: [], message: "当前范围没有可核对的资料，请在「资料范围」选择页面或资料库。" };
  }
  const result = model.generate({
    ...prepared.task,
    libraries: intent === "definition" ? libraries : [...new Set(eligible.map(tagRuleLibrary))],
  }, eligible);
  return { ...result, message: result.message.replace("你可以在这里审核，也可稍后在「待处理」里查看。", "可在标签页的「待处理」核对依据和采纳建议。") };
}
