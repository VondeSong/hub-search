import { expect, it } from "vitest";
import { conversationDate, conversationTime, conversationTitle, groupConversations, type WorkSummary } from "./AgentConversationHistoryData";

const now = new Date(2026, 10, 7, 12).getTime();
const entry = (id: string, time?: number, pinned = false): WorkSummary => ({ id, goal: id, state: "completed", updatedAt: time, pinned });

it("groups by the local day and thirty-day boundary, with pinned conversations present once", () => {
  const today = new Date(2026, 10, 7).getTime(), boundary = new Date(2026, 9, 8).getTime();
  const pinned = entry("pinned", now - 1_000, true);
  const groups = groupConversations([entry("old", boundary - 1), pinned, entry("today", today), entry("yesterday", today - 1), entry("boundary", boundary), entry("unknown")], now);
  expect(groups.map(group => group.label)).toEqual(["已固定", "今天", "过去 30 天", "更早"]);
  expect(groups.map(group => group.works.map(work => work.id))).toEqual([["pinned"], ["today"], ["yesterday", "boundary"], ["old", "unknown"]]);
  expect(groups.flatMap(group => group.works).filter(work => work.id === "pinned")).toHaveLength(1);
});

it("keeps deterministic date order, deduplicates pagination overlap and ignores pin grouping in the archive", () => {
  const a = entry("a", now), b = entry("b", now), oldPin = entry("old-pin", now - 90 * 86_400_000, true);
  expect(groupConversations([b, oldPin, a, b], now).flatMap(group => group.works.map(work => work.id))).toEqual(["old-pin", "a", "b"]);
  const archive = groupConversations([oldPin, b, a], now, true);
  expect(archive.map(group => group.key)).toEqual(["today", "earlier"]);
  expect(archive.flatMap(group => group.works.map(work => work.id))).toEqual(["a", "b", "old-pin"]);
});

it("shows compact truthful times, including missing dates, earlier years and future clock skew", () => {
  expect(conversationTime(now + 10_000, now)).toBe("刚刚");
  expect(conversationTime(now - 2 * 3_600_000, now)).toBe("2 小时");
  expect(conversationTime(new Date(2026, 10, 6, 9).getTime(), now)).toBe("昨天");
  expect(conversationTime(new Date(2026, 9, 30, 9).getTime(), now)).toBe("1 周");
  expect(conversationTime(new Date(2026, 2, 8).getTime(), now)).toBe("3月8日");
  expect(conversationTime(new Date(2025, 2, 8).getTime(), now)).toBe("2025/3/8");
  expect(conversationTime(undefined, now)).toBe("");
  expect(conversationTime(Number.NaN, now)).toBe("");
  expect(conversationDate(Number.NaN)).toBe("更新时间未知");
  expect(conversationTitle({ ...entry("id"), goal: "  多行\n\t标题  " })).toBe("多行 标题");
});
