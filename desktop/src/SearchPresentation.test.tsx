import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HighlightedText, prepareHighlightTerms } from "./SearchPresentation";

describe("search highlighting", () => {
  it("preserves original offsets after expanding Unicode lowercase characters", () => {
    const html = renderToStaticMarkup(<HighlightedText text="İstanbul AI 😀使用AI" terms={["AI", "使用AI"]} />);
    expect(html).toBe('<span>İstanbul </span><mark>AI</mark><span> 😀</span><mark>使用AI</mark>');
  });
  it("keeps contextual Unicode case conversion intact", () => {
    expect(renderToStaticMarkup(<HighlightedText text="ΟΣ AI" terms={["ΟΣ", "AI"]} />))
      .toBe('<mark>ΟΣ</mark><span> </span><mark>AI</mark>');
  });
  it("normalizes one stable term array only once", () => {
    const terms = ["  Hub  ", "", "Hub", "搜索"];
    const first = prepareHighlightTerms(terms);
    const second = prepareHighlightTerms(terms);

    expect(first).toEqual(["hub", "搜索"]);
    expect(second).toBe(first);
  });

  it("gives the longer overlapping term priority", () => {
    const html = renderToStaticMarkup(
      <HighlightedText text="搜索结果列表" terms={["结果", "搜索结果"]} />,
    );

    expect(html).toBe("<mark>搜索结果</mark><span>列表</span>");
  });

  it("keeps a later long match ahead of an earlier overlapping short match", () => {
    const html = renderToStaticMarkup(
      <HighlightedText text="xabc" terms={["xa", "abc"]} />,
    );

    expect(html).toBe("<span>x</span><mark>abc</mark>");
  });

  it("renders dense repeated matches without merging adjacent hits", () => {
    const html = renderToStaticMarkup(
      <HighlightedText text="命中 命中 命中" terms={["命中"]} />,
    );

    expect(html.match(/<mark>/g)).toHaveLength(3);
    expect(html).toContain("</mark><span> </span><mark>");
  });

  it("keeps matching case-insensitive after preprocessing", () => {
    const html = renderToStaticMarkup(
      <HighlightedText text="Open Hub" terms={["hub"]} navigable />,
    );

    expect(html).toContain('<mark data-search-hit="true">Hub</mark>');
  });
});
