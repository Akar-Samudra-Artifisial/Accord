import type { CostClass, Rule, Size, WorkItem } from './types';

export const SIZE_ISSUES: Readonly<Record<Size, number>> = { S: 1, M: 3, L: 6 };

export const COST_WEIGHT: Readonly<Record<CostClass, number>> = {
  'fixed-date': 3,
  standard: 2,
  intangible: 1,
};

export function itemSize(item: WorkItem): number {
  return item.size ?? 1;
}

export function matchesRule(item: WorkItem, rule: Rule): boolean {
  const wanted = rule.value.trim().toLowerCase();
  switch (rule.field) {
    case 'label':
      return item.labels.some((label) => label.toLowerCase() === wanted);
    case 'issueType':
      return item.issueType.toLowerCase() === wanted;
    case 'priority':
      return item.priority.toLowerCase() === wanted;
  }
}

export function firstMatchingRule(item: WorkItem, rules: readonly Rule[]): Rule | undefined {
  return rules.find((rule) => matchesRule(item, rule));
}

export function describeRule(rule: Rule): string {
  const field = rule.field === 'issueType' ? 'issue type' : rule.field;
  return `${field} ${rule.value}`;
}

/** Shift order: lowest cost-of-delay weight, then smallest size, then key. */
export function compareShiftCandidates(a: WorkItem, b: WorkItem): number {
  return (
    COST_WEIGHT[a.costClass] - COST_WEIGHT[b.costClass] ||
    itemSize(a) - itemSize(b) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}
