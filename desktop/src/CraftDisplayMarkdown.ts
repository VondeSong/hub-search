import { collectionMarkdown } from "./CraftCollectionData";

function normalizeCraftContentIndentation(markdown: string): string {
  const contentIndentStack: number[] = [];
  let sawContentContainer = false;
  const normalized = markdown.split(/\r?\n/).map((line) => {
    const leadingSpaces = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^<content(?:\s[^>]*)?>$/i.test(trimmed)) {
      sawContentContainer = true;
      contentIndentStack.push(leadingSpaces + 2);
      return line;
    }
    if (/^<\/content>$/i.test(trimmed)) {
      contentIndentStack.pop();
      return line;
    }
    const contentIndent = contentIndentStack[contentIndentStack.length - 1];
    if (contentIndent !== undefined && leadingSpaces >= contentIndent) return line.slice(contentIndent);
    return line;
  }).join("\n");
  return sawContentContainer ? normalized : normalized.replace(/^ {4}(?=\S)/gm, "");
}

export function renderableCraftMarkdown(markdown: string): string {
  const collections = collectionMarkdown(normalizeCraftContentIndentation(markdown));
  let codePrefix = "\uE000hub-code:";
  while (collections.includes(codePrefix)) codePrefix += "x";
  const code = new Map<string, string>();
  const normalizedSubpageLinks = collections.replace(/(`+)[\s\S]*?\1(?!`)|^(~{3,})[^\n]*\n[\s\S]*?^\2[ \t]*$/gm, value => {
    const key = `${codePrefix}${code.size}\uE001`; code.set(key, value); return key;
  }).replace(
    /\[([^\]\r\n]+)]\(\s*#craft-subpage=([A-Za-z0-9_-]+(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9_-]+)*)\s*\)/g,
    (_match, label: string, documentId: string) => `[${label}](#craft-subpage=${documentId.replace(/\s+/g, "")})`,
  );
  return normalizedSubpageLinks
    .replace(/!\[([^\]\r\n]*)\][ \t]*(?:\r?\n[ \t]*)+\((https?:\/\/[^)\r\n]+)\)/g, "![$1]($2)")
    .replace(/(?:<callout\b[^>]*>[\s\S]*?<\/callout>\s*)+/gi, (group: string) => {
      const bodies = Array.from(group.matchAll(/<callout\b[^>]*>([\s\S]*?)<\/callout>/gi), (match) => match[1].trim());
      const quoted = bodies.join("\n\n").split(/\r?\n/).map((line) => line ? `> ${line}` : "> ").join("\n");
      return `\n\n> <!--craft-block-->\n> \n${quoted}\n\n`;
    })
    .replace(/<page\b([^>]*)>/gi, (_tag, attributes: string) => {
      const title = attributes.match(/title="([^"]+)"/i)?.[1];
      return title ? `\n\n## ${title}\n\n` : "\n\n";
    })
    .replace(/<\/page>/gi, "\n\n")
    .replace(/<pageTitle\b[^>]*>([\s\S]*?)<\/pageTitle>/gi, "\n\n### $1\n\n")
    .replace(/<caption\b[^>]*>([\s\S]*?)<\/caption>/gi, "\n\n> $1\n\n")
    .replace(/<property\b([^>]*)>([\s\S]*?)<\/property>/gi, (_tag, attributes: string, value: string) => {
      const name = attributes.match(/name="([^"]+)"/i)?.[1] || "属性";
      return `\n- **${name}：** ${value.trim()}\n`;
    })
    .replace(/<collection\b[^>]*>/gi, "\n\n")
    .replace(/<\/collection>/gi, "\n\n")
    .replace(/<collectionItem\b[^>]*>/gi, "\n\n- ")
    .replace(/<\/collectionItem>/gi, "\n")
    .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, "**$1**")
    .replace(/<\/?properties(?:\s[^>]*)?>/gi, "")
    .replace(/<highlight\b([^>]*)>([\s\S]*?)<\/highlight>/gi, (_tag, attributes: string, body: string) => {
      const color = attributes.match(/color="([^"]+)"/i)?.[1]?.trim() || "yellow";
      return `[${body}](#preview-highlight=${encodeURIComponent(color)})`;
    })
    .replace(/<\/?content(?:\s[^>]*)?>/gi, "")
    .replace(/<br\s*\/?>/gi, "  \n")
    .replace(/<\/?[a-z][^>\r\n]*>/gi, "")
    .replace(new RegExp(`${codePrefix}\\d+\uE001`, "g"), value => code.get(value) ?? value);
}
