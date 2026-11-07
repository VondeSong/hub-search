import { describe, expect, it } from "vitest";
import { formatDidaPreviewDate } from "./DidaPreviewDate";

const zone = "Asia/Shanghai";

describe("Dida preview dates", () => {
  it("renders the task's offset timestamp as a short local date", () => {
    expect(formatDidaPreviewDate("2026-09-28 07:45:00+0800", new Date("2026-09-25T12:00:00+08:00"), zone)).toBe("9月28日 07:45");
    expect(formatDidaPreviewDate("2026-09-28T07:45:00.000+0800", new Date("2026-09-28T06:00:00+08:00"), zone)).toBe("今天 07:45");
  });

  it("keeps all-day dates local and uses relative labels", () => {
    const now = new Date("2026-09-25T12:00:00+08:00");
    expect(formatDidaPreviewDate("2026-09-26", now, zone)).toBe("明天");
    expect(formatDidaPreviewDate("2026-09-26T00:00:00.000+0800", now, zone)).toBe("明天");
  });

  it("hides unsupported values rather than showing raw timestamps", () => {
    expect(formatDidaPreviewDate("2026-13-28 07:45:00+0800", new Date(), zone)).toBeNull();
    expect(formatDidaPreviewDate("unconverted date", new Date(), zone)).toBeNull();
  });
});
