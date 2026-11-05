import { SIZE_ISSUES } from './cost';
import { buildHorizon, sequentialFinishIndex } from './options';
import type { IsoDate, Size, Sprint } from './types';

export type ProjectionStatus = 'on-track' | 'at-risk';

export interface ProjectionInput {
  /** Provider sprints (active/future); projected sprints are added like the planner does. */
  sprints: readonly Sprint[];
  today: IsoDate;
  /** Pessimistic issues per sprint of the provider team. */
  pessimistic: number;
  /** Open committed issues of the provider (contract deliverables excluded). */
  committedIssues: number;
  /** Sizes of active contracts of the same provider that are ordered before this one. */
  earlierContractSizes: readonly Size[];
  size: Size;
  agreedDateMax: IsoDate;
}

export interface Projection {
  status: ProjectionStatus;
  /** End of the sprint where the cumulative pessimistic capacity covers all work; null when not within the horizon. */
  projectedDate: IsoDate | null;
  /** Issues that must be finished before this contract is done (including it). */
  workAhead: number;
}

/**
 * Daily monitor rule: the provider finishes its open commitments and earlier
 * contracts first, at pessimistic throughput. The contract is at risk when the
 * projected sprint end is later than the agreed latest date, or when the work
 * does not fit within the planning horizon.
 */
export function projectContract(input: ProjectionInput): Projection {
  if (!Number.isFinite(input.pessimistic) || input.pessimistic < 0) {
    throw new Error(`pessimistic must be a non-negative number, got ${input.pessimistic}`);
  }
  if (!Number.isInteger(input.committedIssues) || input.committedIssues < 0) {
    throw new Error(`committedIssues must be a non-negative integer, got ${input.committedIssues}`);
  }
  const workAhead =
    input.committedIssues +
    input.earlierContractSizes.reduce((sum, size) => sum + SIZE_ISSUES[size], 0) +
    SIZE_ISSUES[input.size];
  const horizon = buildHorizon(input.sprints, input.today);
  // Same rule the planner applies to renegotiations (PlannerInput.workAhead).
  const index = sequentialFinishIndex(input.pessimistic, workAhead, horizon.length);
  const projectedDate: IsoDate | null = index >= 0 ? horizon[index].endDate : null;
  const status: ProjectionStatus = projectedDate !== null && projectedDate <= input.agreedDateMax ? 'on-track' : 'at-risk';
  return { status, projectedDate, workAhead };
}
