const KOREA_DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Format a `YYYY-MM-DD` day key in the Asia/Seoul (KST) timezone. Used by
 * ChatView's SessionDateNavigator to bucket entries by Korean calendar day.
 * Extracted from ChatView.tsx (C14). Byte-identical to the original.
 */
export function getKoreaDateKey(date: Date): string {
  const parts = KOREA_DATE_KEY_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
