"use client";

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';

/**
 * A deliberately bounded renderer for the prototype, not a CommonMark engine.
 * Text always becomes React text nodes. HTML, images, embeds and executable URL
 * schemes are never interpreted. Unsupported or incomplete inline syntax stays
 * readable as text; an unfinished fenced code block stays a code block.
 */
export type AnswerBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; blocks: AnswerBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: AnswerBlock[][] }
  | { type: 'table'; headers: string[]; align: ('left' | 'center' | 'right')[]; rows: string[][] };

/** Accept only explicit, credential-free web URLs; never resolve relative URLs. */
export function safeAnswerHref(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function linkEnd(text: string, start: number) {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '(') depth++;
    if (text[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function inline(text: string, depth = 0, allowLinks = true): ReactNode[] {
  if (depth > 6) return [text];
  const result: ReactNode[] = [];
  let plain = '', index = 0;
  const flush = () => { if (plain) { result.push(plain); plain = ''; } };
  while (index < text.length) {
    if (text[index] === '\\' && /[\\`*\[\]()|]/.test(text[index + 1] || '')) {
      plain += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '`') {
      const marker = text.slice(index).match(/^`+/)![0];
      const end = text.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        flush();
        result.push(<code key={'code-' + index}>{text.slice(index + marker.length, end)}</code>);
        index = end + marker.length; continue;
      }
    }
    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) {
        flush();
        result.push(<strong key={'strong-' + index}>{inline(text.slice(index + 2, end), depth + 1, allowLinks)}</strong>);
        index = end + 2; continue;
      }
    }
    if (allowLinks && text[index] === '[' && text[index - 1] !== '!') {
      const labelEnd = text.indexOf('](', index + 1);
      if (labelEnd > index + 1) {
        const end = linkEnd(text, labelEnd + 2);
        if (end !== -1) {
          const href = safeAnswerHref(text.slice(labelEnd + 2, end));
          if (href) {
            flush();
            result.push(<a key={'link-' + index} href={href} target="_blank" rel="noopener noreferrer">{inline(text.slice(index + 1, labelEnd), depth + 1, false)}</a>);
            index = end + 1; continue;
          }
          // Preserve rejected link syntax verbatim so no supplied text vanishes.
          plain += text.slice(index, end + 1); index = end + 1; continue;
        }
      }
    }
    if (allowLinks && text[index] === '<') {
      const end = text.indexOf('>', index + 1);
      const href = end === -1 ? null : safeAnswerHref(text.slice(index + 1, end));
      if (href) {
        flush();
        result.push(<a key={'autolink-' + index} href={href} target="_blank" rel="noopener noreferrer">{text.slice(index + 1, end)}</a>);
        index = end + 1; continue;
      }
    }
    plain += text[index++];
  }
  flush();
  return result;
}

const lineText = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line;
const heading = (line: string) => /^ {0,3}(#{1,3})\s+(.+?)\s*$/.exec(lineText(line));
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(lineText(line));
const quote = (line: string) => /^ {0,3}> ?/.test(lineText(line));
const listMarker = (line: string) => {
  const match = /^( *)([-+*]|\d{1,9}[.)])( +)(.*)$/.exec(lineText(line));
  return match ? { indent: match[1].length, ordered: /^\d/.test(match[2]), start: /^\d/.test(match[2]) ? parseInt(match[2], 10) : 1, contentIndent: match[1].length + match[2].length + match[3].length, content: match[4] } : null;
};

function tableCells(line: string): string[] {
  let value = lineText(line).trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = '', ticks = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\' && index + 1 < value.length) {
      current += value[index] + value[++index]; continue;
    }
    if (value[index] === '`') {
      const marker = value.slice(index).match(/^`+/)![0];
      if (!ticks) ticks = marker;
      else if (ticks === marker) ticks = '';
      current += marker; index += marker.length - 1; continue;
    }
    if (value[index] === '|' && !ticks) { cells.push(current.trim()); current = ''; }
    else current += value[index];
  }
  cells.push(current.trim());
  return cells;
}

function tableHeader(lines: string[], index: number) {
  if (!lines[index]?.includes('|') || !lines[index + 1]) return null;
  const headers = tableCells(lines[index]), separators = tableCells(lines[index + 1]);
  if (headers.length !== separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return { headers, align: separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' as const : cell.endsWith(':') ? 'right' as const : 'left' as const) };
}

function beginsBlock(lines: string[], index: number) {
  return !!(heading(lines[index]) || fence(lines[index]) || quote(lines[index]) || listMarker(lines[index]) || tableHeader(lines, index));
}

export function parseAnswerBlocks(text: string, depth = 0): AnswerBlock[] {
  if (depth > 8) return [{ type: 'paragraph', text }];
  const lines = text.split('\n'), blocks: AnswerBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    const openFence = fence(lines[index]);
    if (openFence) {
      const marker = openFence[1], closing = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
      const start = ++index;
      while (index < lines.length && !closing.test(lineText(lines[index]))) index++;
      const codeLines = lines.slice(start, index), closed = index < lines.length;
      // Keep indentation, blank lines and original CRLF characters for copying.
      const code = codeLines.length ? codeLines.join('\n') + (closed ? '\n' : '') : '';
      blocks.push({ type: 'code', language: openFence[2].trim().split(/\s+/)[0].slice(0, 40), text: code });
      if (closed) index++;
      continue;
    }
    const title = heading(lines[index]);
    if (title) {
      blocks.push({ type: 'heading', level: title[1].length as 1 | 2 | 3, text: title[2].replace(/\s+#+\s*$/, '') });
      index++; continue;
    }
    if (quote(lines[index])) {
      const quoted: string[] = [];
      while (index < lines.length && quote(lines[index])) quoted.push(lineText(lines[index++]).replace(/^ {0,3}> ?/, ''));
      blocks.push({ type: 'quote', blocks: parseAnswerBlocks(quoted.join('\n'), depth + 1) });
      continue;
    }
    const table = tableHeader(lines, index);
    if (table) {
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index]);
        // A malformed row falls back to text instead of silently losing cells.
        if (cells.length !== table.headers.length) break;
        rows.push(cells); index++;
      }
      blocks.push({ type: 'table', ...table, rows });
      continue;
    }
    const first = listMarker(lines[index]);
    if (first) {
      const items: AnswerBlock[][] = [];
      while (index < lines.length) {
        const marker = listMarker(lines[index]);
        if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
        const content = [marker.content]; index++;
        while (index < lines.length) {
          const next = listMarker(lines[index]);
          if (next && next.indent <= first.indent) break;
          if (!lines[index].trim()) {
            let after = index + 1;
            while (after < lines.length && !lines[after].trim()) after++;
            const afterMarker = after < lines.length ? listMarker(lines[after]) : null;
            const afterIndent = lines[after]?.match(/^ */)?.[0].length ?? 0;
            if (after >= lines.length || (afterIndent <= first.indent && !afterMarker)) break;
            content.push(''); index++; continue;
          }
          const indent = /^ */.exec(lines[index])![0].length;
          if (indent <= first.indent) break;
          content.push(lines[index++].slice(Math.min(marker.contentIndent, indent)));
        }
        items.push(parseAnswerBlocks(content.join('\n'), depth + 1));
        // Blank lines between sibling items are allowed, without consuming the
        // blank separating this list from an unrelated paragraph.
        let next = index;
        while (next < lines.length && !lines[next].trim()) next++;
        const sibling = next < lines.length ? listMarker(lines[next]) : null;
        if (sibling?.indent === first.indent && sibling.ordered === first.ordered) index = next;
        else break;
      }
      blocks.push({ type: 'list', ordered: first.ordered, start: first.start, items });
      continue;
    }
    const paragraph = [lineText(lines[index++])];
    while (index < lines.length && lines[index].trim() && !beginsBlock(lines, index)) paragraph.push(lineText(lines[index++]));
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [wrapped, setWrapped] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 3000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text); setCopyState('copied');
    } catch { setCopyState('failed'); }
  };
  return <figure className="ha-answer-code">
    <figcaption className="ha-answer-code-toolbar" data-answer-control>
      <span className="ha-answer-code-language">{language || '代码'}</span>
      <div className="ha-answer-code-actions">
        <button type="button" aria-pressed={wrapped} aria-label={wrapped ? '关闭代码自动换行' : '开启代码自动换行'} title={wrapped ? '关闭自动换行' : '自动换行'} onClick={() => setWrapped(value => !value)}><WrapText size={14}/><span>换行</span></button>
        <button type="button" onClick={copy} aria-label={copyState === 'copied' ? '已复制代码' : '复制代码'}>{copyState === 'copied' ? <Check size={14}/> : <Copy size={14}/>}<span>{copyState === 'copied' ? '已复制' : '复制'}</span></button>
      </div>
    </figcaption>
    <pre className={wrapped ? 'is-wrapped' : undefined} tabIndex={0} aria-label={(language || '') + '代码'}><code>{text}</code></pre>
    <span className={'ha-answer-code-feedback' + (copyState === 'failed' ? ' is-error' : '')} role="status">{copyState === 'failed' ? '未能复制，可选择代码后手动复制。' : copyState === 'copied' ? '代码已复制。' : ''}</span>
  </figure>;
}

function renderBlocks(blocks: AnswerBlock[], prefix = 'answer'): ReactNode[] {
  return blocks.map((block, index) => {
    const key = prefix + '-' + block.type + '-' + index;
    if (block.type === 'paragraph') return <p key={key}>{inline(block.text)}</p>;
    if (block.type === 'heading') {
      const content = inline(block.text);
      return block.level === 1 ? <h1 key={key}>{content}</h1> : block.level === 2 ? <h2 key={key}>{content}</h2> : <h3 key={key}>{content}</h3>;
    }
    if (block.type === 'code') return <CodeBlock key={key} language={block.language} text={block.text}/>;
    if (block.type === 'quote') return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>;
    if (block.type === 'list') {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderBlocks(item, key + '-' + itemIndex)}</li>);
      return block.ordered ? <ol key={key} start={block.start}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    return <div className="ha-answer-table-wrap" key={key} role="region" aria-label="表格，可横向滚动" tabIndex={0}><table>
      <thead><tr>{block.headers.map((cell, cellIndex) => <th scope="col" key={cellIndex} style={{ textAlign: block.align[cellIndex] }}>{inline(cell)}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ textAlign: block.align[cellIndex] }}>{inline(cell)}</td>)}</tr>)}</tbody>
    </table></div>;
  });
}

export default function AssistantAnswerContent({ text }: { text: string }) {
  const blocks = useMemo(() => parseAnswerBlocks(text), [text]);
  return <div className="ha-answer-content">{renderBlocks(blocks)}</div>;
}
