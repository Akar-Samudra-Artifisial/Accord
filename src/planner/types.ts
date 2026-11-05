/**
 * Pure planner types. This module must never import `@forge/*` so the planner
 * stays deterministic and unit-testable outside the Forge runtime.
 * All dates are ISO calendar dates (`YYYY-MM-DD`) interpreted in UTC.
 */

export type IsoDate = string;

export type Size = 'S' | 'M' | 'L';

export type CostClass = 'fixed-date' | 'standard' | 'intangible';

export interface Rule {
  field: 'label' | 'issueType' | 'priority';
  value: string;
}

export interface Charter {
  /** Quarter goals in priority order. */
  priorities: string[];
  /** Work that may never be shifted. */
  redLines: Rule[];
  /** Work that may be shifted to make room. */
  shiftable: Rule[];
  /** Maximum share (0..1) of pessimistic capacity per sprint for other teams. */
  maxExternalShare: number;
  /** Working days the team has to respond to a request. */
  responseDays: number;
  approvers: string[];
  escalationContact?: string;
}

export interface Sprint {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  state: 'closed' | 'active' | 'future';
}

export interface WorkItem {
  key: string;
  summary: string;
  sprintId?: string;
  dueDate?: IsoDate;
  labels: string[];
  issueType: string;
  priority: string;
  epicKey?: string;
  costClass: CostClass;
  /** Size in issues; defaults to 1. */
  size?: number;
}

export interface CapacityRange {
  pessimistic: number;
  realistic: number;
  samples: number[];
  limitedData: boolean;
}

export interface PlannerVariation {
  kind: 'earlier-min';
  days: number;
}

export interface PlannerRequest {
  size: Size;
  /** Minimum useful part, in issues. */
  minSize?: number;
  neededBy: IsoDate;
  costClass: CostClass;
}

export interface PlannerInput {
  request: PlannerRequest;
  charter: Charter;
  capacity: CapacityRange;
  sprints: Sprint[];
  commitments: WorkItem[];
  today: IsoDate;
  variation?: PlannerVariation;
  /**
   * Contract monitor rule (FR-14, NFR-1), set for renegotiations: issues the provider finishes before this
   * request at pessimistic throughput (open work of the counted sprints plus the other contracts). No option
   * promises a date earlier than this sequential projection; shifting a counted issue out of the counted
   * sprints lowers it.
   */
  workAhead?: PlannerWorkAhead;
}

export interface PlannerWorkAhead {
  issues: number;
  /** Commitments included in `issues`. */
  countedKeys: string[];
  /** Sprints whose open issues the monitor counts (active and next). */
  countedSprintIds: string[];
  /** Deliverables of other contracts: never shifted, the agreed work stays where it is. */
  pinnedKeys?: string[];
  /**
   * The provider's other open contracts in the monitor's order (agreed latest date, then id), included in
   * `issues`. The monitor puts this request after those agreed by its own latest date (ties: existing first)
   * and before the rest, which it pushes back. Without it every contract counts as ahead.
   */
  contracts?: Array<{ agreedDateMax: IsoDate; issues: number }>;
}

export type OptionKind = 'on-time' | 'on-time-with-shift' | 'partial' | 'later' | 'reject';

export interface TraceSource {
  type: 'sprint' | 'issue' | 'charter';
  ref: string;
}

export interface TraceStep {
  step: string;
  text: string;
  values: Record<string, number | string>;
  sources: TraceSource[];
}

export interface DateRange {
  min: IsoDate;
  max: IsoDate;
}

export interface ShiftedItem {
  key: string;
  costClass: CostClass;
  toSprintId: string;
}

export interface PlannerOption {
  id: string;
  kind: OptionKind;
  /** Empty strings for `reject`. */
  dateRange: DateRange;
  shifted: ShiftedItem[];
  rulesUsed: string[];
  meetsNeed: boolean;
  shiftCost: number;
  recommended: boolean;
  consequences: { requester: string; provider: string };
  trace: TraceStep[];
  /** Only for `partial`: the remainder delivered at the earliest date without shifting. */
  remainder?: { size: number; dateRange: DateRange };
}

export interface PlannerResult {
  requested: number;
  neededBy: IsoDate;
  capacity: CapacityRange;
  options: PlannerOption[];
}
