import { memo, useMemo, useState } from "react";
import { renderableCraftMarkdown } from "./CraftDisplayMarkdown";
export { renderableCraftMarkdown } from "./CraftDisplayMarkdown";
import { CalendarDays, Check, Copy, FileSpreadsheet, FileText, WrapText } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { parseDocument } from "yaml";
import "katex/dist/katex.min.css";
import "./PreviewContent.css";
import {
  ATTACHMENT_EXTENSIONS,
  attachmentExtension,
  markdownNodeText,
  PreviewAttachmentLink,
  PreviewMarkdownMedia,
} from "./PreviewMarkdown";
import { HighlightedChildren } from "./SearchPresentation";
import type { SearchResult } from "./SearchTypes";
import { cleanCraftDisplayTitle } from "./SearchResultPresentation";
import { formatDidaPreviewDate } from "./DidaPreviewDate";

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBlockAnchors];
const OBSIDIAN_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkInlineTags, remarkBlockAnchors, remarkObsidianHtmlComments];
const REHYPE_PLUGINS = [rehypeKatex];
const previewUrlTransform = (url: string) => url.startsWith("feishu-media://") ? url : defaultUrlTransform(url);

type MarkdownAstNode = {
  type: string;
  value?: string;
  children?: MarkdownAstNode[];
  position?: { start?: { offset?: number } };
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

function remarkObsidianHtmlComments() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children) return;
      node.children = node.children.filter(child => child.type !== "html" || !/^<!--[\s\S]*-->\s*$/.test(child.value || ""));
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

// Operate on parsed text so code, link destinations and HTML stay untouched.
// Obsidian block IDs are navigation metadata, never visible reading content.
export function remarkBlockAnchors() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (["code", "inlineCode", "html"].includes(node.type)) return;
      if (node.type === "paragraph" && node.children?.length) {
        const last = node.children[node.children.length - 1];
        const marker = last.type === "text" && last.value?.match(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/);
        if (marker) {
          last.value = last.value!.slice(0, marker.index).trimEnd();
          const anchor: MarkdownAstNode = { type: "paragraph", children: [], data: {
            hName: "span", hProperties: { id: `^${marker[1]}`, className: "preview-block-anchor" },
          } };
          if (node.children.every(child => child.type === "text" && !child.value?.trim())) {
            node.children = []; node.data = anchor.data;
          } else node.children.push(anchor);
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function remarkDidaHighlights() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children || ["code", "inlineCode", "html"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MarkdownAstNode[] = [];
        const pattern = /==(?:\{(#[\da-fA-F]{6}|#[\da-fA-F]{3})\})?([^=\n]+)==/g;
        let cursor = 0;
        for (const match of child.value.matchAll(pattern)) {
          // Unknown color declarations should remain readable as literal text.
          if (!match[1] && match[2].startsWith("{")) continue;
          if (match.index! > cursor) parts.push({ type: "text", value: child.value.slice(cursor, match.index) });
          parts.push({ type: "didaHighlight", data: { hName: "mark", hProperties: { className: "preview-dida-highlight", style: `background-color: ${match[1] || "#ffe500"}; color: #252a31` } }, children: [{ type: "text", value: match[2] }] });
          cursor = match.index! + match[0].length;
        }
        if (!cursor) return [child];
        if (cursor < child.value.length) parts.push({ type: "text", value: child.value.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}

// Keep inline tags from Craft and Obsidian as selectable text.
export function remarkInlineTags() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children || ["code", "inlineCode", "html", "link", "linkReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MarkdownAstNode[] = [];
        const pattern = /(^|[\s([{（，。；、])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
        let cursor = 0;
        for (const match of child.value.matchAll(pattern)) {
          const start = match.index! + match[1].length;
          if (start > cursor) parts.push({ type: "text", value: child.value.slice(cursor, start) });
          parts.push({ type: "obsidianTag", data: { hName: "span", hProperties: { className: "preview-inline-tag" } }, children: [{ type: "text", value: `#${match[2]}` }] });
          cursor = match.index! + match[0].length;
        }
        if (!parts.length) return [child];
        if (cursor < child.value.length) parts.push({ type: "text", value: child.value.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}

const DIDA_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkDidaHighlights, remarkBlockAnchors];

function CraftPageIcon({ size = 18 }: { size?: number }) {
  return <svg className="preview-page-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M9.17 8.508h5.67a.51.51 0 0 0 .376-.152.504.504 0 0 0 .151-.37c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.521.521 0 0 0 .537.522Zm0 2.59h5.67a.516.516 0 0 0 .527-.531c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.516.516 0 0 0 .537.531Zm0 2.582h2.654c.15 0 .275-.05.376-.147a.478.478 0 0 0 .151-.356.505.505 0 0 0-.15-.37.51.51 0 0 0-.377-.152H9.17a.521.521 0 0 0-.537.522c0 .139.05.258.151.356.101.098.23.147.386.147Zm-3.67 3.9c0 .81.203 1.416.61 1.817.407.402 1.02.603 1.84.603h8.09c.82 0 1.435-.2 1.845-.603.41-.401.615-1.007.615-1.817V6.42c0-.804-.205-1.408-.615-1.813C17.475 4.202 16.86 4 16.04 4H7.95c-.82 0-1.433.202-1.84.607-.407.405-.61 1.01-.61 1.813v11.16Zm1.405-.019V6.44c0-.342.095-.606.283-.793.19-.186.469-.28.84-.28h7.944c.365 0 .641.094.83.28.189.187.283.451.283.793V17.56c0 .342-.095.606-.283.793-.189.186-.465.28-.83.28H8.028c-.371 0-.65-.094-.84-.28-.188-.187-.283-.451-.283-.793Z" fill="currentColor" />
  </svg>;
}

export function remarkCraftToggles() {
  return (tree: MarkdownAstNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const startsWithToggleMarker = (node: MarkdownAstNode) => {
      const offset = node.position?.start?.offset;
      return typeof offset === "number" && source.slice(offset).startsWith("+");
    };
    const decorationKind = (node: MarkdownAstNode): "block" | "focus" | undefined => {
      if (node.type !== "blockquote") return undefined;
      const first = node.children?.[0];
      if (first?.type === "html" && (first as MarkdownAstNode & { value?: string }).value?.includes("craft-block")) {
        node.children?.shift();
        return "block";
      }
      return "focus";
    };
    const decorationClass = (node: MarkdownAstNode) => {
      const names = node.data?.hProperties?.className;
      return Array.isArray(names) ? names.find((name) => typeof name === "string" && name.startsWith("preview-craft-")) : undefined;
    };
    const visit = (node: MarkdownAstNode) => {
      const decoration = decorationKind(node);
      if (decoration) {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, className: [`preview-craft-${decoration}`] },
        };
      }
      if (node.type === "list" && node.children?.length) {
        const items = node.children.filter((child) => child.type === "listItem");
        if (items.length && items.every(startsWithToggleMarker)) {
          node.data = {
            ...node.data,
            hName: "div",
            hProperties: { className: ["preview-craft-toggle-group"] },
          };
          for (const item of items) {
            item.data = {
              ...item.data,
              hName: "details",
              hProperties: { className: ["preview-craft-toggle"], open: true },
            };
            const summary = item.children?.[0];
            if (summary?.type === "paragraph") {
              summary.data = {
                ...summary.data,
                hName: "summary",
                hProperties: { className: ["preview-craft-toggle-summary"] },
              };
            }
          }
        }
      }
      node.children?.forEach(visit);
      if (node.children?.length) {
        for (let index = 1; index < node.children.length;) {
          const previous = node.children[index - 1];
          const current = node.children[index];
          const className = decorationClass(current);
          if (className && className === decorationClass(previous)) {
            previous.children = [...(previous.children ?? []), ...(current.children ?? [])];
            node.children.splice(index, 1);
          } else {
            index += 1;
          }
        }
      }
    };
    visit(tree);
  };
}

const CRAFT_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCraftToggles, remarkInlineTags, remarkBlockAnchors];

export function renderableStandardMarkdown(markdown: string): string {
  return markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function feishuAttribute(attributes: string, name: string): string {
  return attributes.match(new RegExp(`${name}="([^"]+)"`, "i"))?.[1]?.trim() ?? "";
}

export function renderableFeishuMarkdown(markdown: string): string {
  return renderableStandardMarkdown(markdown)
    .replace(/<mention-doc\b([^>]*)>([\s\S]*?)<\/mention-doc>/gi, (_tag, attributes: string, label: string) => {
      const token = feishuAttribute(attributes, "token");
      return token ? `[${label.trim() || "飞书文档"}](https://feishu.cn/wiki/${encodeURIComponent(token)})` : label;
    })
    .replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (_tag, attributes: string, body: string) => {
      const background = feishuAttribute(attributes, "bgcolor");
      const foreground = feishuAttribute(attributes, "color");
      if (background) return `[${body}](#feishu-text-bg=${encodeURIComponent(background)})`;
      if (foreground) return `[${body}](#feishu-text-color=${encodeURIComponent(foreground)})`;
      return body;
    })
    .replace(/<image\b([^>]*)\/?\s*>/gi, (_tag, attributes: string) => {
      const token = feishuAttribute(attributes, "token");
      const width = feishuAttribute(attributes, "width");
      const height = feishuAttribute(attributes, "height");
      const size = width && height ? ` · ${width}×${height}` : "";
      return token ? `\n\n![飞书图片${size}](feishu-media://${token})\n\n` : "\n\n> 飞书图片暂时不可用\n\n";
    })
    .replace(/<sheet\b([^>]*)\/?\s*>/gi, (_tag, attributes: string) => {
      const token = feishuAttribute(attributes, "token");
      return token ? `\n\n[电子表格](#feishu-sheet=${encodeURIComponent(token)})\n\n` : "\n\n> 电子表格请在飞书中查看\n\n";
    })
    .replace(/<task\b[^>]*\/?\s*>/gi, "\n\n> ☑ 飞书任务请在原文中查看\n\n")
    .replace(/<sub-page-list\b([^>]*)\/?\s*>/gi, (_tag, attributes: string) => {
      const token = feishuAttribute(attributes, "wiki-token");
      return token ? `\n\n[子页面列表](#feishu-subpages=${encodeURIComponent(token)})\n\n` : "\n\n> 子页面列表请在飞书中查看\n\n";
    })
    .replace(/<\/?(?:grid|column)(?:\s[^>]*)?>/gi, "\n")
    .replace(/\s*\{(?:color|bgcolor)="[^"]+"\}/gi, "")
    .replace(/<br\s*\/?>/gi, "  \n")
    .replace(/<\/?[a-z][^>\r\n]*>/gi, "");
}

export type DidaPreviewMetadata = {
  label: string;
  value: string;
  kind: "list" | "status" | "priority" | "date" | "tags" | "other";
};

const DIDA_METADATA_KINDS: Record<string, DidaPreviewMetadata["kind"]> = {
  "清单": "list",
  "状态": "status",
  "优先级": "priority",
  "开始": "date",
  "截止": "date",
  "时区": "date",
  "标签": "tags",
};

export function didaPreviewContent(markdown: string, documentTitle?: string): {
  body: string;
  metadata: DidaPreviewMetadata[];
} {
  const lines = renderableStandardMarkdown(markdown).split("\n");
  const firstHeading = lines[0]?.match(/^#\s+(.+?)\s*$/);
  if (firstHeading && (!documentTitle || firstHeading[1].trim() === documentTitle.trim())) {
    lines.shift();
  }
  while (lines[0]?.trim() === "") lines.shift();

  const metadata: DidaPreviewMetadata[] = [];
  while (lines.length) {
    const match = lines[0].match(/^\*\*([^*：:]+)[：:]\*\*\s*(.*?)\s*$/);
    if (!match || !DIDA_METADATA_KINDS[match[1].trim()]) break;
    const label = match[1].trim();
    metadata.push({ label, value: match[2].trim() || "—", kind: DIDA_METADATA_KINDS[label] });
    lines.shift();
  }
  while (lines[0]?.trim() === "") lines.shift();
  return { body: lines.join("\n").trim(), metadata };
}

function frontmatterValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleString();
  if (Array.isArray(value)) return value.map(frontmatterValue).join("、") || "—";
  return JSON.stringify(value);
}

function frontmatterRows(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const indentation = "  ".repeat(depth);
    if (entry && typeof entry === "object" && !Array.isArray(entry) && !(entry instanceof Date)) {
      return [`${indentation}- **${key}**`, ...frontmatterRows(entry, depth + 1)];
    }
    return [`${indentation}- **${key}**：${frontmatterValue(entry)}`];
  });
}

function obsidianFrontmatter(markdown: string): { metadata: string; body: string } | undefined {
  const content = markdown.replace(/^\uFEFF/, "");
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return undefined;
  const lines = content.split(/\r?\n/);
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---" || line.trim() === "...");
  if (closing < 0) return undefined;
  try {
    const document = parseDocument(lines.slice(1, closing + 1).join("\n"));
    if (document.errors.length) return undefined;
    const rows = frontmatterRows(document.toJS());
    return {
      metadata: rows.join("\n"),
      body: lines.slice(closing + 2).join("\n"),
    };
  } catch {
    return undefined;
  }
}

export function renderableObsidianMarkdown(markdown: string): string {
  const frontmatter = obsidianFrontmatter(markdown);
  const output = frontmatter ? `${frontmatter.metadata ? `**文档属性**\n\n${frontmatter.metadata}\n\n` : ""}${frontmatter.body}` : markdown;
  return output
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, (_match, target: string) => {
      const cleanTarget = target.trim();
      if (/\.(?:png|jpe?g|webp|gif|bmp|tiff?|mp4|m4v|mov|webm)(?:[#?].*)?$/i.test(cleanTarget)) {
        return `![${cleanTarget}](${encodeURI(cleanTarget)})`;
      }
      return `**附件：${cleanTarget}**`;
    })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, target: string, alias?: string) => {
      const label = (alias || target).trim();
      return `[${label}](#obsidian-wikilink=${encodeURIComponent(target.trim())})`;
    })
    .replace(/^((?:>\s*)+)\[!([^\]]+)](?:[+-])?\s*(.*)$/gm, (_match, prefix: string, type: string, title: string) =>
      `${prefix}**${title.trim() || type.toUpperCase()}**`);
}

export type PreviewRendererProps = {
  selected: SearchResult;
  markdown: string;
  matchTerms: string[];
  hasSectionContext: boolean;
  onOpenLink: (href?: string, title?: string) => void;
};

function sameMatchTerms(left: string[], right: string[]): boolean {
  return left === right || (left.length === right.length && left.every((term, index) => term === right[index]));
}

export function previewRendererPropsEqual(left: PreviewRendererProps, right: PreviewRendererProps): boolean {
  return left.markdown === right.markdown
    && sameMatchTerms(left.matchTerms, right.matchTerms)
    && left.hasSectionContext === right.hasSectionContext
    && left.onOpenLink === right.onOpenLink
    && left.selected.provider === right.selected.provider
    && left.selected.spaceId === right.selected.spaceId
    && left.selected.documentId === right.selected.documentId
    && left.selected.documentTitle === right.selected.documentTitle;
}

export function renderablePreviewMarkdown(provider: SearchResult["provider"], markdown: string): string {
  if (provider === "craft") return renderableCraftMarkdown(markdown);
  if (provider === "obsidian") return renderableObsidianMarkdown(markdown);
  if (provider === "feishu") return renderableFeishuMarkdown(markdown);
  return renderableStandardMarkdown(markdown);
}

export type PreviewHeading = {
  id: string;
  level: number;
  text: string;
};

function plainHeadingText(value: string): string {
  return value
    .replace(/==(?:\{#[\da-fA-F]{3}(?:[\da-fA-F]{3})?\})?([^=\n]+)==/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[\\*_~]/g, "")
    .trim();
}

export function previewHeadings(markdown: string): PreviewHeading[] {
  const lines = markdown.split(/\r?\n/);
  const headings: PreviewHeading[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;

    const atx = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (atx) {
      const text = plainHeadingText(atx[2]);
      if (text) headings.push({ id: `preview-heading-${index + 1}`, level: atx[1].length, text });
      continue;
    }
    if (index > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(line) && lines[index - 1].trim()) {
      const text = plainHeadingText(lines[index - 1]);
      if (text) headings.push({ id: `preview-heading-${index}`, level: line.trimStart().startsWith("=") ? 1 : 2, text });
    }
  }
  return headings;
}

function PreviewCodeBlock({ children, terms }: { children?: React.ReactNode; terms: string[] }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const code = markdownNodeText(children).replace(/\n$/, "");
  const child = Array.isArray(children) ? children[0] : children;
  const className = child && typeof child === "object" && "props" in child
    ? String((child as { props?: { className?: string } }).props?.className ?? "")
    : "";
  const language = className.match(/language-([^\s]+)/)?.[1] || "文本";
  const lines = code.split("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return <div className={`preview-code-block${wrap ? " wrap" : ""}`}>
    <div className="preview-code-actions">
      <button type="button" aria-pressed={wrap} aria-label={wrap ? "保持原始行宽" : "自动换行"} title={wrap ? "保持原始行宽" : "自动换行"} onClick={() => setWrap((value) => !value)}><WrapText size={14} /></button>
      <button type="button" aria-label={copied ? "已复制" : "复制代码"} title={copied ? "已复制" : "复制代码"} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
    <pre aria-label={`${language}代码`}><code>{lines.map((line, index) => <span className="preview-code-line" key={`${index}:${line}`}>
        <span className="preview-code-line-number" aria-hidden="true">{index + 1}</span>
        <span className="preview-code-line-content"><HighlightedChildren terms={terms}>{line || " "}</HighlightedChildren></span>
      </span>)}</code></pre>
  </div>;
}

function PreviewOutline({ headings, title }: { headings: PreviewHeading[]; title?: string }) {
  if (headings.length < 3) return null;
  const documentTitle = plainHeadingText(cleanCraftDisplayTitle(title || "")) || "文档目录";
  const items = headings.filter((heading, index) => !(
    index === 0 && heading.text.trim().toLocaleLowerCase() === documentTitle.toLocaleLowerCase()
  ));
  const baseLevel = Math.min(...items.map((heading) => heading.level));
  const navigate = (id: string) => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  };
  return <details className="preview-outline" open={items.length <= 12}>
    <summary><span className="preview-outline-disclosure" aria-hidden="true" /><CraftPageIcon size={17} /><strong title={documentTitle}>{documentTitle}</strong></summary>
    <nav aria-label="文档目录"><ol>
      {items.map((heading) => <li key={heading.id} className={`depth-${Math.min(heading.level - baseLevel, 3)}`}>
        <button type="button" onClick={() => navigate(heading.id)}>{heading.text}</button>
      </li>)}
    </ol></nav>
  </details>;
}

function DidaMetadata({ items }: { items: DidaPreviewMetadata[] }) {
  const tags = items.filter(item => item.kind === "tags").flatMap(item => item.value.split("、")).filter(Boolean);
  const dates = items.filter(item => item.kind === "date" && item.label !== "时区")
    .flatMap(item => {
      const value = formatDidaPreviewDate(item.value);
      return value ? [{ label: item.label, value }] : [];
    });
  const start = dates.find(item => item.label === "开始");
  const due = dates.find(item => item.label === "截止");
  const displayDates = start && due && start.value === due.value
    ? [{ label: "开始 / 截止", value: start.value }, ...dates.filter(item => item !== start && item !== due)]
    : dates;
  if (tags.length === 0 && displayDates.length === 0) return null;
  return <header className="preview-task-header">
    <div className="preview-task-details" aria-label="标签和日期">
      {tags.map((tag, index) => <span className="preview-task-tag" key={`${index}:${tag}`}>{tag}</span>)}
      {displayDates.map(item => <span className="preview-task-date" key={item.label} title={`${item.label}：${item.value}`}>
        <CalendarDays size={16} aria-hidden="true" /><span>{item.label} {item.value}</span>
      </span>)}
    </div>
  </header>;
}

function PreviewRendererComponent({ selected, markdown, matchTerms, hasSectionContext, onOpenLink }: PreviewRendererProps) {
  const selectedProvider = selected.provider;
  const selectedSpaceId = selected.spaceId;
  const selectedDocumentId = selected.documentId;
  const selectedDocumentTitle = selected.documentTitle;
  const remarkPlugins = selectedProvider === "craft" ? CRAFT_REMARK_PLUGINS : selectedProvider === "dida365" ? DIDA_REMARK_PLUGINS : selectedProvider === "obsidian" ? OBSIDIAN_REMARK_PLUGINS : REMARK_PLUGINS;
  const components = useMemo<Components>(() => ({
    p: ({ children }) => <p><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></p>,
    li: ({ children }) => <li><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></li>,
    summary: ({ children }) => <summary><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></summary>,
    h1: ({ children, node }) => {
      const headingText = typeof children === "string"
        ? children
        : Array.isArray(children)
          ? children.filter((child): child is string => typeof child === "string").join("")
          : "";
      const isParentDocument = hasSectionContext && headingText.trim() === selectedDocumentTitle?.trim();
      return <h1 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined} className={isParentDocument ? "preview-document-root" : undefined}>
        {isParentDocument && <small>父文档</small>}
        <span><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></span>
      </h1>;
    },
    h2: ({ children, node }) => <h2 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></h2>,
    h3: ({ children, node }) => <h3 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></h3>,
    h4: ({ children, node }) => <h4 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></h4>,
    h5: ({ children, node }) => <h5 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></h5>,
    h6: ({ children, node }) => <h6 id={node?.position?.start.line ? `preview-heading-${node.position.start.line}` : undefined}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></h6>,
    td: ({ children }) => <td><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></td>,
    th: ({ children }) => <th><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></th>,
    table: ({ children }) => <div className="preview-table-scroll"><table>{children}</table></div>,
    pre: ({ children }) => <PreviewCodeBlock terms={matchTerms}>{children}</PreviewCodeBlock>,
    code: ({ children, className }) => <code className={className}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></code>,
    a: ({ href, children }) => {
      const localAnchor = href?.startsWith("#obsidian-wikilink=")
        ? decodeURIComponent(href.slice("#obsidian-wikilink=".length))
        : href?.replace(/%5E/gi, "^") ?? "";
      if (localAnchor.startsWith("#^")) {
        return <a className="preview-text-link" href={href} onClick={(event) => {
          event.preventDefault();
          document.getElementById(localAnchor.slice(1))?.scrollIntoView({ block: "center" });
        }}>{children}</a>;
      }
      const label = markdownNodeText(children).trim();
      const extension = attachmentExtension(label) || attachmentExtension(href ?? "");
      if (href?.startsWith("#preview-highlight=")) {
        const color = decodeURIComponent(href.slice("#preview-highlight=".length)).toLowerCase();
        return <mark className="preview-source-highlight" data-color={color}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></mark>;
      }
      if (href?.startsWith("#feishu-text-bg=") || href?.startsWith("#feishu-text=")) {
        const prefix = href.startsWith("#feishu-text-bg=") ? "#feishu-text-bg=" : "#feishu-text=";
        const color = decodeURIComponent(href.slice(prefix.length)).toLowerCase();
        return <mark className="preview-feishu-text" data-color={color}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></mark>;
      }
      if (href?.startsWith("#feishu-text-color=")) {
        const color = decodeURIComponent(href.slice("#feishu-text-color=".length)).toLowerCase();
        return <span className="preview-feishu-foreground" data-color={color}><HighlightedChildren terms={matchTerms}>{children}</HighlightedChildren></span>;
      }
      if (href?.startsWith("#feishu-sheet=")) {
        const token = decodeURIComponent(href.slice("#feishu-sheet=".length));
        return <a className="preview-feishu-embed" href={`https://feishu.cn/sheets/${encodeURIComponent(token)}`} onClick={(event) => { event.preventDefault(); onOpenLink(event.currentTarget.href); }}>
          <span><FileSpreadsheet size={18} /></span><strong>{children}</strong><small>在飞书中查看</small>
        </a>;
      }
      if (href?.startsWith("#feishu-subpages=")) {
        const token = decodeURIComponent(href.slice("#feishu-subpages=".length));
        return <a className="preview-feishu-embed" href={`https://feishu.cn/wiki/${encodeURIComponent(token)}`} onClick={(event) => { event.preventDefault(); onOpenLink(event.currentTarget.href); }}>
          <span><FileText size={18} /></span><strong>{children}</strong><small>在飞书中查看</small>
        </a>;
      }
      if (href?.startsWith("#craft-subpage=")) {
        return <a className="preview-subpage-card" href={href} onClick={(event) => { event.preventDefault(); onOpenLink(href, label); }}>
          <CraftPageIcon size={22} /><strong>{children}</strong>
        </a>;
      }
      return href && ATTACHMENT_EXTENSIONS.has(extension)
        ? <PreviewAttachmentLink
          href={href}
          label={label || `附件.${extension}`}
          provider={selectedProvider}
          spaceId={selectedSpaceId}
          documentId={selectedDocumentId}
          onOpen={onOpenLink}
        />
        : <a className="preview-text-link" href={href} onClick={(event) => { event.preventDefault(); onOpenLink(href); }}>{children}</a>;
    },
    img: ({ src, alt }) => <PreviewMarkdownMedia
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      provider={selectedProvider}
      spaceId={selectedSpaceId}
      documentId={selectedDocumentId}
    />,
  }), [hasSectionContext, matchTerms, onOpenLink, selectedDocumentId, selectedDocumentTitle, selectedProvider, selectedSpaceId]);

  const frontmatter = useMemo(() => selectedProvider === "obsidian" ? obsidianFrontmatter(markdown) : null, [markdown, selectedProvider]);
  const didaContent = useMemo(
    () => selectedProvider === "dida365" ? didaPreviewContent(markdown, selectedDocumentTitle) : null,
    [markdown, selectedDocumentTitle, selectedProvider],
  );
  const content = useMemo(
    () => renderablePreviewMarkdown(selectedProvider, didaContent?.body ?? frontmatter?.body ?? markdown),
    [didaContent, frontmatter, markdown, selectedProvider],
  );
  const headings = useMemo(() => previewHeadings(content), [content]);
  return <div className={`preview-document preview-document-${selectedProvider}`}>
    {didaContent && <DidaMetadata items={didaContent.metadata} />}
    <PreviewOutline headings={headings} title={selectedDocumentTitle || selected.title} />
    {frontmatter?.metadata && <details key={selectedDocumentId} className="preview-properties" open={matchTerms.some(term => term.trim() && frontmatter.metadata.toLocaleLowerCase().includes(term.toLocaleLowerCase())) ? true : undefined}><summary>文档属性</summary><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={previewUrlTransform}>{frontmatter.metadata}</ReactMarkdown></details>}
    <ReactMarkdown
    remarkPlugins={remarkPlugins}
    rehypePlugins={REHYPE_PLUGINS}
    components={components}
    urlTransform={previewUrlTransform}
  >{content}</ReactMarkdown>
  </div>;
}

export const PreviewRenderer = memo(PreviewRendererComponent, previewRendererPropsEqual);
