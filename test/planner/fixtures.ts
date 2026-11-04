import { computeCapacity } from '../../src/planner';
import type { Charter, PlannerInput, Sprint, WorkItem } from '../../src/planner';

export const SPRINTS: Sprint[] = [
  { id: 's0', name: 'Sprint 40', startDate: '2026-10-19', endDate: '2026-11-01', state: 'closed' },
  { id: 's1', name: 'Sprint 41', startDate: '2026-11-02', endDate: '2026-11-15', state: 'active' },
  { id: 's2', name: 'Sprint 42', startDate: '2026-11-16', endDate: '2026-11-29', state: 'future' },
  { id: 's3', name: 'Sprint 43', startDate: '2026-11-30', endDate: '2026-12-13', state: 'future' },
];

export const CHARTER: Charter = {
  priorities: ['Holiday release', 'Ledger migration'],
  redLines: [
    { field: 'label', value: 'security' },
    { field: 'issueType', value: 'Incident' },
  ],
  shiftable: [
    { field: 'priority', value: 'Low' },
    { field: 'label', value: 'tech-debt' },
  ],
  maxExternalShare: 0.5,
  responseDays: 2,
  approvers: ['lead-payments'],
};

export function item(key: string, sprintId: string | undefined, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key,
    summary: `Work ${key}`,
    sprintId,
    labels: [],
    issueType: 'Story',
    priority: 'Medium',
    costClass: 'standard',
    ...overrides,
  };
}

/** `count` medium-priority, non-shiftable fillers in a sprint. */
export function fillers(prefix: string, sprintId: string, count: number): WorkItem[] {
  return Array.from({ length: count }, (_, i) => item(`${prefix}-${100 + i}`, sprintId));
}

export function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    request: { size: 'M', neededBy: '2026-11-29', costClass: 'fixed-date' },
    charter: CHARTER,
    // sorted [8,9,10,10,11,12] -> realistic 10, pessimistic 9
    capacity: computeCapacity([8, 10, 9, 12, 10, 11]),
    sprints: SPRINTS,
    commitments: [],
    today: '2026-11-05',
    ...overrides,
  };
}

/**
 * Capacity pessimistic 9 / share 0.5 -> 4 issues per sprint for other teams.
 * Sprint 41 and 42 each hold 8 issues -> 1 free issue each before 2026-11-29.
 */
export function shiftScenario(extra: Partial<WorkItem> = {}): WorkItem[] {
  return [
    item('PAY-1', 's1', { priority: 'Low', labels: ['tech-debt'], costClass: 'intangible', summary: 'Ledger cleanup', ...extra }),
    item('PAY-2', 's1', { priority: 'Low', costClass: 'intangible', ...extra }),
    item('PAY-3', 's1', { priority: 'Low', costClass: 'standard', ...extra }),
    ...fillers('PAY', 's1', 5),
    item('PAY-11', 's2', { priority: 'Low', costClass: 'intangible', ...extra }),
    item('PAY-12', 's2', { priority: 'Low', costClass: 'fixed-date', ...extra }),
    ...fillers('PAZ', 's2', 6),
  ];
}
