import { betweenDates, formatDate } from '../format/dates';
import type { ContractStatus } from '../negotiation/types';

/**
 * Display fields for Rovo action output. Agents show `*Display` values verbatim ("Nov 29, 2026",
 * "On track"); the raw values stay available as `*Iso` dates and `statusCode` for machines.
 */
export const CONTRACT_STATUS_DISPLAY: Readonly<Record<ContractStatus, string>> = {
  applying: 'Updating Jira',
  'on-track': 'On track',
  'at-risk': 'At risk',
  unknown: 'Not enough data',
};

/** "on Nov 29, 2026" / "between Nov 20, 2026 and Nov 29, 2026"; `fallback` when no date is set. */
export function rangeDisplay(min: string | null | undefined, max: string | null | undefined, fallback: string): string {
  if (!min && !max) return fallback;
  return betweenDates(min || String(max), max || String(min));
}

export function optionDates(range: { min: string; max: string }) {
  return { dateRangeIso: range, dateRangeDisplay: rangeDisplay(range.min, range.max, 'No date offered') };
}

function projectedDisplay(projectedDate: string | null, status: ContractStatus): string {
  if (projectedDate) return formatDate(projectedDate);
  if (status === 'at-risk') return 'Beyond planning horizon';
  if (status === 'unknown') return 'Not enough data';
  return 'Not evaluated yet';
}

interface ContractDates {
  agreedDateMin: string;
  agreedDateMax: string;
  projectedDate: string | null;
  status: ContractStatus;
}

/** Replaces the raw contract date/status fields with `*Iso`, `statusCode` and `*Display` fields. */
export function contractDisplay<T extends ContractDates>(contract: T) {
  const { agreedDateMin, agreedDateMax, projectedDate, status, ...rest } = contract;
  return {
    ...rest,
    agreedDateMinIso: agreedDateMin,
    agreedDateMaxIso: agreedDateMax,
    agreedDisplay: rangeDisplay(agreedDateMin, agreedDateMax, 'No date agreed'),
    projectedDateIso: projectedDate,
    projectedDisplay: projectedDisplay(projectedDate, status),
    statusCode: status,
    statusDisplay: CONTRACT_STATUS_DISPLAY[status],
  };
}

/** Sprint start/end as `*Iso` plus `*Display` ("Nov 15, 2026"). */
export function sprintDates(startDate: string | null | undefined, endDate: string | null | undefined) {
  return {
    startDateIso: startDate ?? null,
    startDateDisplay: formatDate(startDate, 'Not set'),
    endDateIso: endDate ?? null,
    endDateDisplay: formatDate(endDate, 'Not set'),
  };
}

/** Need date as `neededByIso` plus `neededByDisplay` ("Nov 29, 2026"). */
export function neededByDates(neededBy: string) {
  return { neededByIso: neededBy, neededByDisplay: formatDate(neededBy) };
}
