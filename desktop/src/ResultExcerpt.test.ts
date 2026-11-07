import { expect, it } from "vitest";
import { cleanSearchSnippet, resultExcerpt } from "./ResultExcerpt";
it("prefers matching prose while preserving metadata-only evidence", () => {
 expect(resultExcerpt("来源：专业手册.docx。专业接口需要逐项确认。", ["专业"]).text).toBe("…专业接口需要逐项确认。");
 expect(resultExcerpt("来源：专业手册.docx。本文介绍接口。", ["专业"]).text).toContain("专业手册");
});
it("removes repeated titles only when the remaining body also matches", () => {
 expect(resultExcerpt("专业手册：专业接口说明", ["专业"], 120, "专业手册").text).toBe("专业接口说明");
 expect(resultExcerpt("专业手册：接口说明", ["专业"], 120, "专业手册").text).toContain("专业手册");
});
it("keeps late matches near the start even inside the character budget", () => {
 const excerpt = resultExcerpt("背景".repeat(40) + "专业内容", ["专业"], 320);
 expect(excerpt.text.indexOf("专业")).toBeLessThanOrEqual(9);
 expect(resultExcerpt("https://example.org/abc 正文专业内容", ["专业"]).text).not.toContain("https://");
 expect(resultExcerpt("https://example.org/abc", ["example"]).text).toContain("example");
});
it("keeps late matching text in a shortened excerpt", () => {
 const text = "背景".repeat(150) + "门槛命中" + "后文".repeat(100);
 const excerpt = resultExcerpt(text, ["门槛"]);
 expect(excerpt.truncated).toBe(true);
 expect(excerpt.text).toContain("门槛");
 expect(excerpt.text.length).toBeLessThanOrEqual(182);
});
it("cleans link syntax but retains URL-only match evidence", () => {
 expect(resultExcerpt("看[说明](https://example.org)", ["说明"]).text).toBe("看说明");
 expect(resultExcerpt("看[说明](https://example.org)", ["example"]).text).toContain("example.org");
});
it("retains different query terms in the label and URL", () => {
 expect(cleanSearchSnippet("[使用说明](https://example.org/AI)", ["使用", "AI"])).toContain("example.org/AI");
 expect(cleanSearchSnippet("[使用说明](https://example.org/AI)", ["使用"])).toBe("使用说明");
});
it("never truncates a long phrase or misplaces a late Unicode match", () => {
 const phrase = "长短语".repeat(60);
 expect(resultExcerpt("背景".repeat(90) + phrase + "结尾", [phrase], 40).text).toContain(phrase);
 expect(resultExcerpt("İ".repeat(90) + "使用AI", ["使用AI"], 40).text).toContain("使用AI");
});
