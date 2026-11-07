import { describe, expect, it } from "vitest";
import { editorSaveErrorDetail } from "./EditorSaveStatus";

describe("editorSaveErrorDetail", () => {
  it("keeps useful backend messages without a redundant Error prefix", () => {
    expect(editorSaveErrorDetail(new Error("磁盘暂时不可写"))).toBe("磁盘暂时不可写");
    expect(editorSaveErrorDetail("Error: 请求超时")).toBe("请求超时");
  });

  it("provides a useful fallback for empty or opaque failures", () => {
    expect(editorSaveErrorDetail(null)).toBe("发生未知错误，请稍后重试");
    expect(editorSaveErrorDetail({})).toBe("发生未知错误，请稍后重试");
  });
});
