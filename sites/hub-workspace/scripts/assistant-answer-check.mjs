import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(new URL('../app/AssistantAnswerContent.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const executable = compiled.replace(/from (["'])([^"']+)\1/g, (_, quote, specifier) => 'from ' + JSON.stringify(import.meta.resolve(specifier)));
const { default: AnswerContent, safeAnswerHref, parseAnswerBlocks } = await import('data:text/javascript;base64,' + Buffer.from(executable).toString('base64'));
const render = text => renderToStaticMarkup(createElement(AnswerContent, { text }));
let checks = 0;
function check(label, run) { run(); checks++; console.log('✓ ' + label); }

check('链接只接受无凭据的 HTTP(S)，拒绝可执行协议、相对地址和控制字符', () => {
  assert.equal(safeAnswerHref('https://example.com/a?q=1'), 'https://example.com/a?q=1');
  assert.equal(safeAnswerHref('http://example.com/'), 'http://example.com/');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.com', '/local', 'https://name:secret@example.com', 'https://example.com\n/test', 'https:\\example.com']) assert.equal(safeAnswerHref(value), null);
});
check('HTML和拒绝的链接保留为文本，不产生可执行节点或远程图片', () => {
  const markup = render('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![image](https://example.com/image.png)');
  assert.ok(markup.includes('&lt;script&gt;'));
  assert.ok(!markup.includes('<script'));
  assert.ok(!markup.includes('<img'));
  assert.ok(!markup.includes('href="javascript:'));
  assert.ok(markup.includes('[x](javascript:alert(1))'));
});
check('代码保留缩进、引号、空行和 CRLF；未闭合围栏仍可阅读', () => {
  const body = '  $scores = 58, 72\r\n\r\n"count: $($scores.Count)"\r\n';
  assert.equal(parseAnswerBlocks('```powershell\r\n' + body + '```')[0].text, body);
  const unfinished = parseAnswerBlocks('```text\n  line one\n\nlast line');
  assert.equal(unfinished[0].type, 'code');
  assert.equal(unfinished[0].text, '  line one\n\nlast line');
});
check('分级标题、嵌套列表与原始起始编号保持结构', () => {
  const blocks = parseAnswerBlocks('# One\n\n## Two\n\n### Three\n\n3. parent\n   - child\n4. next');
  assert.deepEqual(blocks.slice(0, 3).map(block => block.level), [1, 2, 3]);
  assert.equal(blocks[3].type, 'list');
  assert.equal(blocks[3].start, 3);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[3].items[0][1].type, 'list');
  assert.ok(render('3. parent\n4. next').includes('<ol start="3">'));
});
check('表格保留代码内竖线，异常行不静默丢弃内容', () => {
  const blocks = parseAnswerBlocks('| Syntax | Note |\n| --- | --- |\n| `a | b` | pipe |\n| extra | cells | retained |');
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].rows, [['`a | b`', 'pipe']]);
  assert.equal(blocks[1].type, 'paragraph');
  assert.ok(blocks[1].text.includes('retained'));
});
check('合法链接、强调和行内代码按语义输出，外链保留隔离属性', () => {
  const markup = render('**结果** 是 `3 / 5`。\n\n[官方文档](https://example.com/docs)');
  assert.ok(markup.includes('<strong>结果</strong>'));
  assert.ok(markup.includes('<code>3 / 5</code>'));
  assert.ok(markup.includes('target="_blank" rel="noopener noreferrer"'));
});
console.log(`${checks} 项回答内容边界检查通过。`);
