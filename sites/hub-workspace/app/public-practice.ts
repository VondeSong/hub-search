import type { HubItem, Section } from "./data";

type PracticeIdentity = Pick<HubItem, "kind"> & Partial<Pick<HubItem, "originInsightId" | "workId">>;
export type PracticeDocument = {
  sections: Section[];
  checkKeys: string[][];
  initialChecks: Record<string, boolean>;
};

/** This small format belongs only to the public-case practice notes. */
export function isPublicPractice(item?: PracticeIdentity | null): boolean {
  return !!item && item.kind === "note" && !!item.originInsightId && !!item.workId?.startsWith("public-work-");
}

function parseLines(body: string): { sections: Section[]; checks: boolean[] } {
  const sections: Section[] = [];
  const checks: boolean[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) sections.push({ type: "p", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const heading = /^##[\t ]+(.+?)\s*$/.exec(line);
    const check = /^[\t ]*-[\t ]+\[([ xX])\][\t ]+(.+?)\s*$/.exec(line);
    if (heading) {
      flush(); sections.push({ type: "h2", text: heading[1] });
    } else if (check) {
      flush();
      const previous = sections[sections.length - 1];
      if (previous?.type === "checklist") previous.items!.push(check[2]);
      else sections.push({ type: "checklist", items: [check[2]] });
      checks.push(check[1].toLowerCase() === "x");
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return { sections, checks };
}

function documentFor(itemId: string, sections: Section[], checks: boolean[]): PracticeDocument {
  const occurrences = new Map<string, number>();
  const initialChecks: Record<string, boolean> = {};
  let checkIndex = 0;
  const checkKeys = sections.map(section => section.type === "checklist" ? (section.items || []).map(text => {
    const occurrence = occurrences.get(text) || 0;
    occurrences.set(text, occurrence + 1);
    // The key is independent of headings, section positions and the note title.
    const key = itemId + ":practice:" + JSON.stringify([text, occurrence]);
    initialChecks[key] = checks[checkIndex++] || false;
    return key;
  }) : []);
  return { sections, checkKeys, initialChecks };
}

export function parsePracticeMarkdown(itemId: string, body: string): PracticeDocument {
  const parsed = parseLines(body);
  return documentFor(itemId, parsed.sections, parsed.checks);
}

/** Read projection for the earlier notes saved as paragraphs; never mutates storage. */
export function projectPracticeDocument(itemId: string, original: Section[]): PracticeDocument {
  const sections: Section[] = [];
  const checks: boolean[] = [];
  const append = (section: Section) => {
    const previous = sections[sections.length - 1];
    if (previous?.type === "checklist" && section.type === "checklist") previous.items!.push(...(section.items || []));
    else sections.push({ ...section, ...(section.items ? { items: [...section.items] } : {}) });
  };
  for (const section of original) {
    if (section.type === "p") {
      const parsed = parseLines(section.text || "");
      parsed.sections.forEach(append); checks.push(...parsed.checks);
    } else {
      append(section);
      if (section.type === "checklist") checks.push(...(section.items || []).map(() => false));
    }
  }
  return documentFor(itemId, sections, checks);
}

export function practiceChecked(document: PracticeDocument, marks: Record<string, boolean>, section: number, item: number): boolean {
  const key = document.checkKeys[section]?.[item];
  return key ? marks[key] ?? document.initialChecks[key] ?? false : false;
}

export function practiceMarkdown(document: PracticeDocument, marks: Record<string, boolean>): string {
  return document.sections.map((section, sectionIndex) => {
    if (section.type === "h2") return "## " + (section.text || "");
    if (section.type === "checklist") return (section.items || []).map((text, itemIndex) =>
      "- [" + (practiceChecked(document, marks, sectionIndex, itemIndex) ? "x" : " ") + "] " + text
    ).join("\n");
    return section.text || section.items?.join("\n") || "";
  }).join("\n\n");
}

/** Plain-text linkification: no HTML, Markdown execution or non-HTTPS links. */
export function publicPracticeLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const matcher = /https:\/\/[^\s<>"'\[\]{}]+/gi;
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const start = match.index!;
    let candidate = match[0].replace(/[.,;:!?，。；：！？、）》】]+$/u, "");
    while (candidate.endsWith(")") && (candidate.match(/\)/g)?.length || 0) > (candidate.match(/\(/g)?.length || 0)) candidate = candidate.slice(0, -1);
    let safe = false;
    try {
      const url = new URL(candidate);
      safe = url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
    } catch { /* Invalid URLs remain ordinary text. */ }
    if (!safe) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: candidate, href: candidate });
    cursor = start + candidate.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length ? parts : [{ text }];
}
