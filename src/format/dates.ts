/**
 * The one date format shown to users (UI, Jira comments): "Nov 29, 2026", always the UTC calendar
 * date in en-US. Stored values and date inputs stay ISO (`YYYY-MM-DD`).
 */
const DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(value: string): Date | null {
  const text = value.trim();
  // A bare date is a calendar date; parse it at UTC midnight so no time zone shifts the day.
  const date = new Date(ISO_DATE.test(text) ? `${text}T00:00:00Z` : text.includes('T') || text.endsWith('Z') ? text : text.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Nov 29, 2026"; unparseable input is returned unchanged, empty input as `fallback`. */
export function formatDate(value: string | null | undefined, fallback = ''): string {
  if (!value) return fallback;
  const date = parse(value);
  return date ? DATE.format(date) : value;
}

/** "Nov 5, 2026, 14:03 UTC" for timestamps (ISO or SQL `YYYY-MM-DD HH:MM:SS`, read as UTC). */
export function formatDateTime(value: string | null | undefined, fallback = ''): string {
  if (!value) return fallback;
  const date = parse(value);
  return date ? `${DATE_TIME.format(date)} UTC` : value;
}

/** "between Nov 20, 2026 and Nov 29, 2026", or "on Nov 29, 2026" when both ends are the same day. */
export function betweenDates(min: string, max: string): string {
  return min === max ? `on ${formatDate(min)}` : `between ${formatDate(min)} and ${formatDate(max)}`;
}

/** "Nov 20, 2026 – Nov 29, 2026" with both ends formatted; one date when both are equal. */
export function formatDateRange(min: string | null | undefined, max: string | null | undefined, fallback = ''): string {
  if (!min && !max) return fallback;
  if (!min || !max || min === max) return formatDate(min || max);
  return `${formatDate(min)} – ${formatDate(max)}`;
}
