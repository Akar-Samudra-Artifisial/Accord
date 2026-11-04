import { computeCapacity } from '../planner';
import type { Charter, PlannerInput, Sprint, WorkItem } from '../planner';

/**
 * Demo scenario (Mobile asks Payments for a refund API). Throughput history is
 * labelled "Simulated history" in the UI because issue creation dates cannot be
 * back-filled through the Jira API (see PRD, Demo data).
 */
export const DEMO_TODAY = '2026-11-05';

export const DEMO_SIMULATED_THROUGHPUT: readonly number[] = [8, 10, 9, 12, 10, 11];

export const DEMO_PAYMENTS_CHARTER: Charter = {
  priorities: ['Holiday release', 'Ledger migration'],
  redLines: [
    { field: 'label', value: 'security' },
    { field: 'issueType', value: 'Incident' },
  ],
  shiftable: [
    { field: 'priority', value: 'Low' },
    { field: 'priority', value: 'Medium' },
    { field: 'label', value: 'tech-debt' },
  ],
  maxExternalShare: 0.25,
  responseDays: 2,
  approvers: ['payments-lead'],
};

export const DEMO_PAYMENTS_SPRINTS: Sprint[] = [
  { id: 'pay-41', name: 'Payments Sprint 41', startDate: '2026-11-02', endDate: '2026-11-15', state: 'active' },
  { id: 'pay-42', name: 'Payments Sprint 42', startDate: '2026-11-16', endDate: '2026-11-29', state: 'future' },
  { id: 'pay-43', name: 'Payments Sprint 43', startDate: '2026-11-30', endDate: '2026-12-13', state: 'future' },
];

const work = (key: string, summary: string, sprintId: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  key,
  summary,
  sprintId,
  labels: [],
  issueType: 'Story',
  priority: 'High',
  costClass: 'standard',
  ...extra,
});

export const DEMO_PAYMENTS_COMMITMENTS: WorkItem[] = [
  work('PAY-101', 'Holiday promo checkout', 'pay-41', { costClass: 'fixed-date', size: 4 }),
  work('PAY-102', 'Ledger cleanup', 'pay-41', { priority: 'Low', labels: ['tech-debt'], costClass: 'intangible', size: 2 }),
  work('PAY-103', 'Card vault rotation', 'pay-41', { labels: ['security'], size: 2 }),
  work('PAY-111', 'Ledger migration phase 2', 'pay-42', { size: 6 }),
  work('PAY-112', 'Settlement report export', 'pay-42', { priority: 'Medium', size: 2 }),
];

export function demoPlannerInput(variationDays?: number): PlannerInput {
  return {
    request: { size: 'M', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' },
    charter: DEMO_PAYMENTS_CHARTER,
    capacity: computeCapacity(DEMO_SIMULATED_THROUGHPUT),
    sprints: DEMO_PAYMENTS_SPRINTS,
    commitments: DEMO_PAYMENTS_COMMITMENTS,
    today: DEMO_TODAY,
    variation: variationDays ? { kind: 'earlier-min', days: variationDays } : undefined,
  };
}
