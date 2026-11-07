import {
  AlignLeft,
  FileText,
  FolderTree,
  Heading1,
  ListTree,
  Paperclip,
  Tag,
  Tags,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Provider } from "./ProviderLabels";
import { searchMatchRanges } from "./SearchMatch";

const EMPTY_HIGHLIGHT_TERMS: readonly string[] = [];
const normalizedHighlightTerms = new WeakMap<readonly string[], readonly string[]>();

export function prepareHighlightTerms(terms: readonly string[]): readonly string[] {
  const cached = normalizedHighlightTerms.get(terms);
  if (cached) return cached;

  const prepared = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((term) => term.toLocaleLowerCase());
  const value = prepared.length ? prepared : EMPTY_HIGHLIGHT_TERMS;
  normalizedHighlightTerms.set(terms, value);
  return value;
}

function matchFieldLabel(field: string): string {
  if (field === "title") return "页面名称";
  if (field === "alias") return "别名";
  if (field === "heading") return "章节标题";
  if (field === "tag") return "标签";
  if (field === "attachment") return "附件名";
  if (field === "path") return "路径";
  return "正文";
}

function matchFieldIcon(field: string) {
  if (field === "title") return Heading1;
  if (field === "alias") return Tags;
  if (field === "heading") return ListTree;
  if (field === "tag") return Tag;
  if (field === "attachment") return Paperclip;
  if (field === "path") return FolderTree;
  if (field === "body") return AlignLeft;
  return FileText;
}

const MATCH_FIELD_ORDER = ["title", "heading", "body", "alias", "tag", "attachment", "path", "document"];

export function MatchFieldIcons({ matchField, provider }: { matchField: string; provider: Provider }) {
  const fields = matchField
    .split(",")
    .map((field) => field.trim())
    .filter((field, index, values) => Boolean(field) && values.indexOf(field) === index)
    .sort((left, right) => {
      const leftIndex = MATCH_FIELD_ORDER.indexOf(left);
      const rightIndex = MATCH_FIELD_ORDER.indexOf(right);
      return (leftIndex < 0 ? MATCH_FIELD_ORDER.length : leftIndex)
        - (rightIndex < 0 ? MATCH_FIELD_ORDER.length : rightIndex);
    });
  const visibleFields = fields.length ? fields : ["document"];
  const title = fields.length ? `命中${fields.map(matchFieldLabel).join("、")}` : "文档";

  return (
    <span className={`match-icons ${provider}`} title={title} aria-label={title}>
      {visibleFields.map((field) => {
        const Icon = matchFieldIcon(field);
        return <Icon key={field} className={`match-icon ${field}`} aria-hidden="true" />;
      })}
    </span>
  );
}

export function HighlightedText({
  text,
  terms,
  navigable = false,
}: {
  text: string;
  terms: readonly string[];
  navigable?: boolean;
}) {
  const needles = prepareHighlightTerms(terms);
  if (!needles.length) return <>{text}</>;

  const ranges = searchMatchRanges(text, needles);
  if (!ranges.length) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) {
      parts.push(<span key={`text-${cursor}`}>{text.slice(cursor, range.start)}</span>);
    }
    parts.push(<mark key={`match-${range.start}`} data-search-hit={navigable ? "true" : undefined}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

export function HighlightedChildren({ children, terms }: { children: ReactNode; terms: readonly string[] }): ReactNode {
  if (typeof children === "string") return <HighlightedText text={children} terms={terms} navigable />;
  if (Array.isArray(children)) {
    return children.map((child, index) => <HighlightedChildren key={index} terms={terms}>{child}</HighlightedChildren>);
  }
  return children;
}
