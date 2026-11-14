import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PreviewRenderer,
  previewRendererPropsEqual,
  didaPreviewContent,
  previewHeadings,
  renderableCraftMarkdown,
  renderableFeishuMarkdown,
  renderableObsidianMarkdown,
  renderablePreviewMarkdown,
  type PreviewRendererProps,
} from "./PreviewRenderer";
import type { SearchResult } from "./SearchTypes";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "result-1",
    entityKey: "craft:page:block",
    documentId: "page",
    blockId: "block",
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: "章节",
    documentTitle: "页面",
    path: "Car/页面",
    snippet: "",
    matchTerms: ["命中"],
    matchField: "body",
    matchCount: 1,
    subMatches: [],
    ...overrides,
  };
}

it("hides Obsidian journal metadata comments while keeping code examples visible", () => {
  const html = renderToStaticMarkup(createElement(PreviewRenderer, {
    selected: result({ provider: "obsidian" }),
    markdown: "<!-- hub-journal:v1 begin hidden-record-id -->\n\n正文保留\n\n<!-- hub-journal:v1 end hidden-record-id -->\n\n```html\n<!-- visible-code-example -->\n```",
    matchTerms: [], hasSectionContext: false, onOpenLink: () => {},
  }));
  expect(html).toContain("正文保留");
  expect(html).not.toContain("hidden-record-id");
  expect(html).toContain("visible-code-example");
});

describe("preview markdown conversion", () => {
  it.each(["craft", "obsidian"] as const)("hides block metadata while preserving navigation and code for %s", (provider) => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider }),
      markdown: "正文\n\n^block-id\n\n尾行 ^inline-id\n\n`^literal-id`\n\n```text\n^code-id\n```\n\n普通 ^ 文本\n\n[跳转](#^block-id)",
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html).toContain('id="^block-id"');
    expect(html).toContain('id="^inline-id"');
    expect(html).not.toContain('>^block-id<');
    expect(html).not.toContain('尾行 ^inline-id');
    expect(html).toContain('^literal-id');
    expect(html).toContain('^code-id');
    expect(html).toContain('普通 ^ 文本');
    expect(html).toContain('href="#%5Eblock-id"');
  });
  it("keeps Craft image labels and URLs together", () => {
    expect(renderableCraftMarkdown("![Image]\n(https://r.craft.do/example)")).toBe(
      "![Image](https://r.craft.do/example)",
    );
  });

  it("turns Craft page containers into visible headings", () => {
    const markdown = renderableCraftMarkdown('<page title="子页面">\n正文\n</page>');
    expect(markdown).toContain("## 子页面");
    expect(markdown).toContain("正文");
  });

  it("keeps multiline Craft callouts together", () => {
    const markdown = renderableCraftMarkdown("<callout>第一行\n第二行</callout>");
    expect(markdown).toContain("> 第一行\n> 第二行");
  });

  it("merges adjacent Craft block decorations into one callout", () => {
    const markdown = renderableCraftMarkdown("<callout>**最推荐**</callout>\n\n<callout>推荐正文</callout>");
    expect(markdown.match(/<!--craft-block-->/g)).toHaveLength(1);
    expect(markdown).toContain("> **最推荐**\n> \n> 推荐正文");
  });

  it("does not apply Craft structural conversion to Feishu markdown", () => {
    expect(renderablePreviewMarkdown("feishu", "普通 Markdown")).toBe("普通 Markdown");
  });

  it("converts Feishu rich blocks into previewable markdown", () => {
    const markdown = renderableFeishuMarkdown([
      '<mention-doc token="doc123" type="wiki">项目文档</mention-doc>',
      '<text bgcolor="yellow">重点</text>',
      '<image token="img123" width="640" height="480" align="center"/>',
      '<sheet token="sheet123"/>',
      '<task task-id="task123"/>',
      '<sub-page-list wiki-token="wiki123"/>',
    ].join("\n"));
    expect(markdown).toContain("[项目文档](https://feishu.cn/wiki/doc123)");
    expect(markdown).toContain("[重点](#feishu-text-bg=yellow)");
    expect(markdown).toContain("![飞书图片 · 640×480](feishu-media://img123)");
    expect(markdown).toContain("[电子表格](#feishu-sheet=sheet123)");
    expect(markdown).toContain("飞书任务请在原文中查看");
    expect(markdown).toContain("[子页面列表](#feishu-subpages=wiki123)");
  });

  it("keeps Feishu foreground colors distinct from background highlights", () => {
    const markdown = renderableFeishuMarkdown('<text color="red">红字</text> <text bgcolor="blue">蓝底</text>');
    expect(markdown).toContain("[红字](#feishu-text-color=red)");
    expect(markdown).toContain("[蓝底](#feishu-text-bg=blue)");
  });

  it("preserves Craft collection labels and properties", () => {
    const markdown = renderableCraftMarkdown(
      '<collection><title>项目</title><collectionItem><property name="status">Done</property><title>任务一</title></collectionItem></collection>',
    );
    expect(markdown).toContain("**项目**");
    expect(markdown).toContain("**status：** Done");
    expect(markdown).toContain("**任务一**");
  });

  it("preserves Craft highlight colors", () => {
    expect(renderableCraftMarkdown('<highlight color="green">重点</highlight>')).toContain(
      "[重点](#preview-highlight=green)",
    );
  });

  it("builds a stable outline and ignores headings inside code fences", () => {
    expect(previewHeadings([
      "# 总览",
      "## [安装](https://example.com)",
      "```md",
      "# 不是标题",
      "```",
      "补充说明",
      "---",
    ].join("\n"))).toEqual([
      { id: "preview-heading-1", level: 1, text: "总览" },
      { id: "preview-heading-2", level: 2, text: "安装" },
      { id: "preview-heading-6", level: 2, text: "补充说明" },
    ]);
  });

  it("renders Craft plus blocks as collapsible content instead of source code", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ documentTitle: "7_Catia" }),
      markdown: [
        "### 其他问题",
        "",
        "+ 当前 CATIA 数据被加载",
        "",
        "  报错的核心原因",
        "",
        "  ## 解决方案",
        "",
        "  | 文件 | 状态 |",
        "  | --- | --- |",
        "  | CATProduct | 保存 |",
      ].join("\n"),
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html).toContain("<details class=\"preview-craft-toggle\" open=\"\">");
    expect(html).toContain("<summary>当前 CATIA 数据被加载</summary>");
    expect(html).toContain("class=\"preview-table-scroll\"");
    expect(html).not.toContain("<pre>");
  });

  it("keeps Craft blocks and focus quotes visually distinct and grouped", () => {
    const markdown = [
      "<callout>**最推荐**</callout>",
      "",
      "<callout>推荐正文</callout>",
      "",
      "普通正文",
      "",
      "> **Linux：**",
      "",
      "> `command`",
      "",
      "> **Windows：**",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result(),
      markdown,
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html.match(/preview-craft-block/g)).toHaveLength(1);
    expect(html.match(/preview-craft-focus/g)).toHaveLength(1);
    expect(html).toContain("最推荐");
    expect(html).toContain("Windows：");
  });

  it("renders compact code lines and a semantic table", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "obsidian" }),
      markdown: [
        "```javascript",
        "const first = 1;",
        "const second = 2;",
        "```",
        "",
        "| 类别 | 次数 |",
        "| --- | --- |",
        "| 工具使用 | 2 |",
      ].join("\n"),
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html.match(/preview-code-line-number/g)).toHaveLength(2);
    expect(html).toContain("aria-label=\"javascript代码\"");
    expect(html).not.toContain("preview-code-toolbar");
    expect(html).toContain("class=\"preview-table-scroll\"");
    expect(html).toContain("<th>类别</th>");
  });

  it("renders the document title as a compact hierarchical outline root", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ documentTitle: "Craft 更新说明", title: "Craft 更新说明" }),
      markdown: [
        "# Craft 更新说明",
        "## New Colors",
        "### Before",
        "### After",
      ].join("\n\n"),
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html).toContain("preview-outline-disclosure");
    expect(html).toContain("preview-page-icon");
    expect(html).toContain("<strong title=\"Craft 更新说明\">Craft 更新说明</strong>");
    expect(html).toContain("class=\"depth-0\"");
    expect(html).toContain("class=\"depth-1\"");
    expect(html.match(/>Craft 更新说明</g)).toHaveLength(2);
  });

  it("uses only the visible text of a linked document title in the outline", () => {
    const linkedTitle = "[project-steward](C:/Users/yongs/.codex/skills/project-steward/SKILL.md)";
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ documentTitle: linkedTitle, title: linkedTitle }),
      markdown: [
        "# project-steward",
        "## 已经做好的项目",
        "## 正在做的项目",
        "## 修改项目时",
      ].join("\n\n"),
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html).toContain("<strong title=\"project-steward\">project-steward</strong>");
    expect(html).not.toContain("C:/Users/yongs/.codex/skills/project-steward/SKILL.md");
  });

  it("renders Craft subpages as compact cards with the Craft page icon", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result(),
      markdown: "[物料选型](#craft-subpage=materials)",
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html).toContain("class=\"preview-subpage-card\"");
    expect(html).toContain("class=\"preview-page-icon\"");
    expect(html).toContain("<strong>物料选型</strong>");
    expect(html).not.toContain("lucide-file-text");
  });

  it("repairs line-wrapped Craft subpage destinations before rendering", () => {
    const markdown = renderableCraftMarkdown(
      "[A523：男孩的情感教育！](#craft-subpage=4AAAC15C-8870-4ACE-BA68-\n0D13EA021748)",
    );
    expect(markdown).toBe(
      "[A523：男孩的情感教育！](#craft-subpage=4AAAC15C-8870-4ACE-BA68-0D13EA021748)",
    );
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result(),
      markdown,
      matchTerms: [],
      hasSectionContext: false,
      onOpenLink: () => undefined,
    }));
    expect(html).toContain("class=\"preview-subpage-card\"");
    expect(html).toContain("href=\"#craft-subpage=4AAAC15C-8870-4ACE-BA68-0D13EA021748\"");
    expect(html).not.toContain("](#craft-subpage=");
  });

  it("extracts TickTick task fields and removes its duplicate title", () => {
    const preview = didaPreviewContent(
      "# 完成预览优化\n\n**清单：** Hub\n**状态：** 未完成\n**优先级：** 高\n**截止：** 2026-09-26\n**标签：** UI、预览\n\n正文说明\n\n## 检查项\n- [ ] 验证表格",
      "完成预览优化",
    );
    expect(preview.metadata).toEqual([
      { label: "清单", value: "Hub", kind: "list" },
      { label: "状态", value: "未完成", kind: "status" },
      { label: "优先级", value: "高", kind: "priority" },
      { label: "截止", value: "2026-09-26", kind: "date" },
      { label: "标签", value: "UI、预览", kind: "tags" },
    ]);
    expect(preview.body).toBe("正文说明\n\n## 检查项\n- [ ] 验证表格");
  });

  it.each(["未完成", "已完成", "已放弃"])("renders task metadata for %s without a duplicate title or status", (status) => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "dida365", documentTitle: "测试任务" }),
      markdown: `# 测试任务\n\n**清单：** 总控\n**状态：** ${status}\n**时区：** Asia/Shanghai\n**截止：** 2026-09-26T00:00:00.000+0800\n**标签：** 客户、历史\n\n正文说明`,
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html).not.toContain(`aria-label="${status}"`);
    expect(html).not.toContain("preview-task-title");
    expect(html).toContain("preview-task-tag");
    expect(html).toContain("客户");
    expect(html).toContain("历史");
    expect(html).toContain("截止 ");
    expect(html).not.toContain("2026-09-26T00:00:00.000+0800");
    expect(html).toContain("正文说明");
    expect(html).not.toContain("Asia/Shanghai");
    expect(html).not.toContain("总控");
    expect(html).not.toContain("preview-task-metadata");
    expect(html).not.toContain("preview-task-status");
  });

  it("combines identical start and due dates into one compact label", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "dida365", documentTitle: "上班" }),
      markdown: "# 上班\n\n**状态：** 未完成\n**开始：** 2026-09-28 07:45:00+0800\n**截止：** 2026-09-28 07:45:00+0800\n\n正文",
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html.match(/class="preview-task-date"/g)).toHaveLength(1);
    expect(html).toContain("开始 / 截止");
    expect(html).not.toContain("+0800");
  });

  it("renders Obsidian frontmatter and embedded media", () => {
    const markdown = renderableObsidianMarkdown(
      "---\naliases:\n  - 测试别名\nstatus: active\n---\n![[assets/demo.png]]\n[[目标页面|显示名称]]",
    );
    expect(markdown).toContain("文档属性");
    expect(markdown).toContain("测试别名");
    expect(markdown).toContain("![assets/demo.png](assets/demo.png)");
    expect(markdown).toContain("[显示名称](#obsidian-wikilink=");
  });

  it("shows Obsidian properties once and styles inline tags without changing links or code", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "obsidian" }),
      markdown: "---\nauthor: pandaWL\n---\n2020年11月30日 05:30 #东北人 [https://chatgpt.com](https://chatgpt.com)\n\n`#代码`",
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html.match(/文档属性/g)).toHaveLength(1);
    expect(html).toContain('class="preview-properties"');
    expect(html).not.toContain("<blockquote");
    expect(html).toContain('<span class="preview-inline-tag">#东北人</span>');
    expect(html).toContain('<a class="preview-text-link" href="https://chatgpt.com">https://chatgpt.com</a>');
    expect(html).toContain("<code>#代码</code>");
  });

  it("styles Craft body tags while leaving code and linked labels intact", () => {
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "craft" }),
      markdown: "#黄立夏\n\n`#代码` [#链接](https://example.com)",
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html).toContain('<span class="preview-inline-tag">#黄立夏</span>');
    expect(html).toContain("<code>#代码</code>");
    expect(html).toContain('href="https://example.com">#链接</a>');
    expect(html).not.toContain('<span class="preview-inline-tag">#链接</span>');
  });

  it("renders Dida colored highlights and cleans outline labels without changing code", () => {
    const markdown = "## =={#FFE500}热管理==\n\n## =={#abc}车身==\n\n## ==普通高亮==\n\n`=={#FFE500}代码==`\n\n```text\n=={#FFE500}代码块==\n```";
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "dida365" }), markdown,
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html).toContain('background-color:#FFE500');
    expect(html).toContain('background-color:#abc');
    expect(html).toContain('>热管理</mark>');
    expect(html).toContain('>普通高亮</mark>');
    expect(html).toContain('=={#FFE500}代码==');
    expect(html).toContain('=={#FFE500}代码块==');
    expect(previewHeadings(markdown).map(item => item.text)).toEqual(["热管理", "车身", "普通高亮"]);
  });

  it("does not repeat a linked task title in the preview body", () => {
    const title = "[道家思想的精髓是什么？](https://mp.weixin.qq.com/s/abc)";
    const html = renderToStaticMarkup(createElement(PreviewRenderer, {
      selected: result({ provider: "dida365", documentTitle: title }),
      markdown: `# ${title}\n\n**状态：** 未完成\n\n正文`,
      matchTerms: [], hasSectionContext: false, onOpenLink: () => undefined,
    }));
    expect(html).not.toContain('<a href="https://mp.weixin.qq.com/s/abc">道家思想的精髓是什么？</a>');
    expect(html).toContain("<p>正文</p>");
    expect(html).not.toContain("](https://");
  });

  it("dispatches preview conversion by provider", () => {
    expect(renderablePreviewMarkdown("craft", '<page title="子页面">正文</page>')).toContain("## 子页面");
    expect(renderablePreviewMarkdown("obsidian", "[[目标页面|显示名称]]")).toContain("[显示名称](#obsidian-wikilink=");
  });

  it("treats refreshed result objects with equal render inputs as unchanged", () => {
    const onOpenLink = () => undefined;
    const base: PreviewRendererProps = {
      selected: result(),
      markdown: "正文命中",
      matchTerms: ["命中"],
      hasSectionContext: true,
      onOpenLink,
    };

    expect(previewRendererPropsEqual(base, {
      ...base,
      selected: { ...base.selected, id: "refreshed-result", path: "更新后的结果路径" },
      matchTerms: ["命中"],
    })).toBe(true);
    expect(previewRendererPropsEqual(base, { ...base, markdown: "正文已变化" })).toBe(false);
  });
});
