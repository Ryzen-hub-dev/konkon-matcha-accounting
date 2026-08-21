const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

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
