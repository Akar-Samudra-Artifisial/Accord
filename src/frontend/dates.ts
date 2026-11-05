import { addDays } from '../planner/dates';

export const DEFAULT_NEEDED_BY_DAYS = 21;

/**
 * Default "Needed by" for a new request: today (UTC calendar date) plus `days`. Without a valid
 * default the UI Kit DatePicker shows a bogus date (2/18/1993).
 */
export function defaultNeededBy(now: Date = new Date(), days: number = DEFAULT_NEEDED_BY_DAYS): string {
  return addDays(now.toISOString().slice(0, 10), days);
}
