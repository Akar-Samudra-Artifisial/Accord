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
