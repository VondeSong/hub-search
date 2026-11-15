import {expect,it} from "vitest";
import {effectiveNewLimit,estimatedStudyMinutes,futureStudyDays} from "./FlashcardStudyExperience";
import type {FlashcardDashboardStats} from "./FlashcardTypes";
const stats = (values:Partial<FlashcardDashboardStats>) => values as FlashcardDashboardStats;
it("keeps unlimited preferences and uses only positive same-day native allowance",()=>{
  expect(effectiveNewLimit(0,5)).toBe(0); expect(effectiveNewLimit(5,3)).toBe(8); expect(effectiveNewLimit(5,-3)).toBe(5);
});
it("does not invent a time estimate without five valid timings or a round",()=>{
  expect(estimatedStudyMinutes(stats({timedReviewCount:4,averageReviewMs:20000}),10)).toBeNull();
  expect(estimatedStudyMinutes(stats({timedReviewCount:5,averageReviewMs:20000}),0)).toBeNull();
  expect(estimatedStudyMinutes(stats({timedReviewCount:5,averageReviewMs:20000}),10)).toBe(4);
});
it("uses the native calendar day for seven dates including a year boundary and leaves unknown stats unknown",()=>{
  expect(futureStudyDays(stats({}))).toEqual([]);
  const days=futureStudyDays(stats({studyDay:"2026-12-29",futureDue:[{date:"2027-01-01",count:3}]}));
  expect(days).toHaveLength(7); expect(days[3]).toEqual({date:"2027-01-01",count:3});expect(days[6].date).toBe("2027-01-04");
});
