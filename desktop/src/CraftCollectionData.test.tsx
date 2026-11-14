// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { collectionMarkdown, decodeCraftCollection, parseCraftCollection } from "./CraftCollectionData";
import { CraftCollectionView } from "./CraftCollectionView";
import { renderableCraftMarkdown } from "./CraftDisplayMarkdown";
import { PreviewRenderer } from "./PreviewRenderer";
import type { SearchResult } from "./SearchTypes";

const source = `<collection><title>真实字段示例</title><properties><property name="状态"></property></properties><content>
<collectionItem><title>样件 A</title><properties><property name="状态">待核对</property><property name="数量">3</property></properties><content>保留正文 **依据**。</content></collectionItem>
<collectionItem><title>样件 B</title><properties><property name="状态">已核对</property></properties></collectionItem>
</content></collection>`;

it("keeps actual fields, empty cells and record body without inventing schema", () => {
  const parsed = parseCraftCollection(source)!;
  expect(parsed.columns).toEqual(["状态", "数量"]);
  expect(parsed.rows).toHaveLength(2);
  expect(parsed.rows[0].values).toEqual({状态: "待核对", 数量: "3"});
  expect(parsed.rows[0].body).toBe("保留正文 **依据**。");
  expect(parsed.rows[1].values.数量).toBeUndefined();
  const markdown = collectionMarkdown(source);
  const encoded = markdown.match(/hub-craft-collection\n([^\n]+)/)![1];
  expect(decodeCraftCollection(encoded)).toEqual(parsed);
  expect(decodeCraftCollection("%invalid")).toBeUndefined();
  expect(decodeCraftCollection(encodeURIComponent('{"rows":[{}]}'))).toBeUndefined();
});

it("preserves partial input, fenced examples and inline code", () => {
  const example = `\`\`\`xml\n${source}\n\`\`\``;
  expect(collectionMarkdown(example)).toBe(example);
  expect(renderableCraftMarkdown(example)).toBe(example);
  expect(renderableCraftMarkdown("`<collection>literal</collection>`")).toBe("`<collection>literal</collection>`");
  expect(collectionMarkdown("before <collection>partial")).toBe("before <collection>partial");
  expect(parseCraftCollection("<collection>partial")).toBeUndefined();
});

it("renders cached collections in the actual preview and switches between table and gallery", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const selected = { provider: "craft", spaceId: "craft", documentId: "root", title: "合集", path: "", matchTerms: [] } as unknown as SearchResult;
  const html = renderToStaticMarkup(createElement(PreviewRenderer, { selected, markdown: source, matchTerms: [], hasSectionContext: false, onOpenLink: () => {} }));
  expect(html).toContain("preview-craft-collection");
  expect(html).toContain("<th>状态</th>");
  expect(html).toContain("保留正文");
  expect(html).not.toContain("language-hub-craft-collection");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CraftCollectionView collection={parseCraftCollection(source)!} renderValue={value => value} />));
    const gallery = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "画廊")!;
    await act(async () => gallery.click());
    expect(container.querySelectorAll(".preview-craft-gallery > article")).toHaveLength(2);
    expect(container.textContent).toContain("3");
    expect(parseCraftCollection(source)?.rows[0].values.状态).toBe("待核对");
  } finally { await act(async () => root.unmount()); }
});
