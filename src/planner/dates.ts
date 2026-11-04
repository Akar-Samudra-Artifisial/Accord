import type { IsoDate } from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function parseIsoDate(value: IsoDate): number {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new Error(`Invalid ISO date "${value}": expected YYYY-MM-DD`);
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (formatUtc(ms) !== value) {
    throw new Error(`Invalid ISO date "${value}": not a real calendar date`);
  }
  return ms;
}

function formatUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return formatUtc(parseIsoDate(value) + days * DAY_MS);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS);
}

export function isValidIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}
