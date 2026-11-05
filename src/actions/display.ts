import { betweenDates, formatDate } from '../format/dates';
import type { ContractStatus } from '../negotiation/types';

/**
 * Contract direction from the viewer's point of view. "both": the viewer is on the provider and the requester
 * team (it counts as something they owe); "none": on neither. There is no "unknown" value.
 */
export type ContractDirection = 'you-owe' | 'owed-to-you' | 'both' | 'none';

/**
 * Direction of a contract from the viewer's point of view, so agents never infer it. `viewerTeamKeys` are the
 * viewer's own teams (approver/lead teams, else teams whose project they can browse). Deterministic: the same
 * viewer and contract always give the same values, whatever team the user asked about. `directionDisplay` is
 * always a ready sentence for the agent to copy verbatim.
 */
export function contractDirection(
  row: { requester: string; requesterTeamKey: string | null; provider: string; providerTeamKey: string | null },
  viewerTeamKeys: ReadonlySet<string>,
): {
  viewerRole: 'provider' | 'requester' | 'both' | null;
  direction: ContractDirection;
  counterpartTeam: string | null;
  directionDisplay: string;
} {
  const asProvider = row.providerTeamKey !== null && viewerTeamKeys.has(row.providerTeamKey);
  const asRequester = row.requesterTeamKey !== null && viewerTeamKeys.has(row.requesterTeamKey);
  const neutral = `${row.provider} delivers to ${row.requester}`;
  if (asProvider && asRequester) {
    // Both teams are the viewer's: the receiving team is the counterpart of what they owe.
    return { viewerRole: 'both', direction: 'both', counterpartTeam: row.requester, directionDisplay: neutral };
  }
  if (asProvider) {
    return { viewerRole: 'provider', direction: 'you-owe', counterpartTeam: row.requester, directionDisplay: `Your team ${row.provider} owes this to ${row.requester}` };
  }
  if (asRequester) {
    return { viewerRole: 'requester', direction: 'owed-to-you', counterpartTeam: row.provider, directionDisplay: `${row.provider} owes this to your team ${row.requester}` };
  }
  return { viewerRole: null, direction: 'none', counterpartTeam: null, directionDisplay: neutral };
}

/**
 * Display fields for Rovo action output. Agents show `*Display` values verbatim ("Nov 29, 2026",
 * "On track"); the raw values stay available as `*Iso` dates and `statusCode` for machines.
 */

export const CONTRACT_STATUS_DISPLAY: Readonly<Record<ContractStatus, string>> = {
  applying: 'Updating Jira',
  'on-track': 'On track',
  'at-risk': 'At risk',
  unknown: 'Not enough data',
  superseded: 'Superseded',
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
