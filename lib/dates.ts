const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftDateKey(value: string, days: number) {
  if (!isValidDateKey(value)) throw new Error("Choose a valid calendar date.");
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// A due date is a calendar label, not an instant to move between time zones.
export function formatCalendarDate(value: string | Date, locale: string) {
  const key = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  if (!isValidDateKey(key)) return "—";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));
}

export function businessPeriodKeys(now: Date, timeZone: string) {
  const today = dateKeyInTimeZone(now, timeZone);
  return { today, month: `${today.slice(0, 8)}01`, days: Array.from({ length: 7 }, (_, index) => shiftDateKey(today, index - 6)) };
}

// Old manual journals also stored date-only input at UTC midnight.
export function journalReportDateExpression(timeZone: string) {
  return { $ifNull: ["$businessDate", { $dateToString: {
    format: "%Y-%m-%d", date: "$date", timezone: { $cond: [{ $eq: ["$source", "MANUAL"] }, "UTC", timeZone] },
  } }] };
}

export function dateKeyInTimeZone(value: string | number | Date, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Choose a valid date.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function localDateTimeToUtcIso(value: string, timezoneOffsetMinutes?: number) {
  const trimmed = value.trim();
  const parts = LOCAL_DATE_TIME.exec(trimmed);
  if (!parts) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error("Choose a valid date and time.");
    return parsed.toISOString();
  }

  const [, year, month, day, hour, minute, second = "0"] = parts;
  const localDate = new Date(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  );
  if (Number.isNaN(localDate.getTime())) throw new Error("Choose a valid date and time.");
  const offset = timezoneOffsetMinutes ?? localDate.getTimezoneOffset();
  return new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  ) + offset * 60_000).toISOString();
}
