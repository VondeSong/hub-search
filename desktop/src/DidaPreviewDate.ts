const DAY_MS = 24 * 60 * 60 * 1000;

type CalendarParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(date: Date, timeZone: string): CalendarParts {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute") };
}

export function formatDidaPreviewDate(
  value: string,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? 0);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  const validCalendarDate = new Date(Date.UTC(year, month - 1, day));
  if (validCalendarDate.getUTCFullYear() !== year || validCalendarDate.getUTCMonth() + 1 !== month || validCalendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;

  let display: CalendarParts = { year, month, day, hour, minute };
  if (hourText !== undefined) {
    const offset = offsetText?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") ?? "";
    const date = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText ?? "00"}${offset}`);
    if (Number.isNaN(date.getTime())) return null;
    display = localParts(date, timeZone);
  }
  const today = localParts(now, timeZone);
  const dayDifference = (Date.UTC(display.year, display.month - 1, display.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY_MS;
  const dateLabel = dayDifference === 0 ? "今天"
    : dayDifference === 1 ? "明天"
    : dayDifference === 2 ? "后天"
    : dayDifference === -1 ? "昨天"
    : display.year === today.year ? `${display.month}月${display.day}日`
    : `${display.year}年${display.month}月${display.day}日`;
  const showTime = hourText !== undefined && (display.hour !== 0 || display.minute !== 0);
  return showTime ? `${dateLabel} ${String(display.hour).padStart(2, "0")}:${String(display.minute).padStart(2, "0")}` : dateLabel;
}
