export type CraftCollection = { title: string; columns: string[]; rows: { title: string; values: Record<string, string>; body: string }[] };
const attribute = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1];
const titleOf = (value: string) => value.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? "";

function blocks(text: string, tag: string) {
  const ranges: { start: number; end: number; body: string; open: string }[] = [];
  const code: [number, number][] = [];
  let fence: { char: string; length: number; start: number } | undefined;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = {char: marker[1][0], length: marker[1].length, start: offset};
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && line.trim().slice(marker[1].length).trim() === "") {
        code.push([fence.start, offset + line.length]); fence = undefined;
      }
    }
    offset += line.length;
  }
  if (fence) code.push([fence.start, text.length]);
  for (const inline of text.matchAll(/(`+)[\s\S]*?\1(?!`)/g)) code.push([inline.index!, inline.index! + inline[0].length]);
  let depth = 0, start = 0, content = 0, open = "";
  for (const match of text.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"))) {
    if (code.some(([a,b]) => match.index! >= a && match.index! < b)) continue;
    if (!match[0].startsWith("</")) {
      if (depth++ === 0) { start = match.index!; content = start + match[0].length; open = match[0]; }
    } else {
      if (depth === 0) return [];
      if (--depth === 0) ranges.push({start, end: match.index! + match[0].length, body: text.slice(content, match.index!), open});
    }
  }
  return depth === 0 ? ranges : [];
}

export function parseCraftCollection(raw: string): CraftCollection | undefined {
  const outer = blocks(raw, "collection")[0];
  if (!outer) return;
  const items = blocks(outer.body, "collectionItem");
  const header = outer.body.slice(0, items[0]?.start ?? outer.body.length);
  const columns = new Set<string>();
  for (const property of header.matchAll(/<property\b([^>]*)>/gi)) {
    const name = attribute(property[1], "name"); if (name) columns.add(name);
  }
  const rows = items.map(item => {
    const values: Record<string, string> = Object.create(null);
    const body = item.body.replace(/<property\b([^>]*)>([\s\S]*?)<\/property>/gi, (_tag, attributes: string, value: string) => {
      const name = attribute(attributes, "name") || "属性";
      columns.add(name); values[name] = [values[name], value.trim()].filter(Boolean).join("\n\n"); return "";
    }).replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "").replace(/<\/?(?:content|properties)\b[^>]*>/gi, "").trim();
    return { title: titleOf(item.body) || "未命名记录", values, body };
  });
  return { title: titleOf(header) || "合集", columns: [...columns], rows };
}

export function collectionMarkdown(markdown: string): string {
  const collections = blocks(markdown, "collection");
  let result = "", offset = 0;
  for (const block of collections) {
    const parsed = parseCraftCollection(markdown.slice(block.start, block.end));
    if (!parsed) continue;
    result += markdown.slice(offset, block.start) + `\n\n\`\`\`hub-craft-collection\n${encodeURIComponent(JSON.stringify(parsed))}\n\`\`\`\n\n`;
    offset = block.end;
  }
  return result + markdown.slice(offset);
}

export function decodeCraftCollection(value: string): CraftCollection | undefined {
  try {
    const parsed = JSON.parse(decodeURIComponent(value.trim())) as CraftCollection;
    if (typeof parsed.title !== "string" || !Array.isArray(parsed.columns) || !parsed.columns.every(v => typeof v === "string")
      || !Array.isArray(parsed.rows) || !parsed.rows.every(row => typeof row.title === "string" && typeof row.body === "string"
        && row.values && typeof row.values === "object" && Object.values(row.values).every(v => typeof v === "string"))) return;
    return parsed;
  } catch { return; }
}
