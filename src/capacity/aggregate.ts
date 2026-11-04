import { CAPACITY_WINDOW, computeCapacity } from '../planner';
import type { CapacityRange, CostClass, IsoDate, Sprint, WorkItem } from '../planner';
import type { JiraIssue } from '../jira/issues';
import type { JiraSprint } from '../jira/sprints';

/**
 * Pure capacity/commitment aggregation (no Forge calls) so it can be unit tested.
 */

export type ThroughputSource = 'jira' | 'simulated';

export interface ThroughputSample {
  sprintId: string;
  sprintName: string;
  completedCount: number;
  endDate: IsoDate;
  source: ThroughputSource;
}

export interface TeamCapacity extends CapacityRange {
  source: ThroughputSource | 'none';
  /** Human label shown next to the range in the UI. */
  sourceLabel: 'Jira sprint history' | 'Simulated history' | 'No history';
}

export function isDone(issue: JiraIssue): boolean {
  return issue.fields.status?.statusCategory?.key === 'done';
}

/** Completed-issue count of one closed sprint. */
export function sampleFromClosedSprint(sprint: Sprint, issues: readonly JiraIssue[]): ThroughputSample {
  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    completedCount: issues.filter(isDone).length,
    endDate: sprint.endDate,
    source: 'jira',
  };
}

/** Oldest first, last CAPACITY_WINDOW sprints. */
export function latestSamples(samples: readonly ThroughputSample[]): ThroughputSample[] {
  return [...samples].sort((a, b) => a.endDate.localeCompare(b.endDate)).slice(-CAPACITY_WINDOW);
}

/**
 * Prefers real Jira history; simulated history (demo teams) is used only when
 * Jira has no closed sprints, and is labelled as such.
 */
export function capacityFromSamples(samples: readonly ThroughputSample[]): TeamCapacity {
  const jiraSamples = latestSamples(samples.filter((sample) => sample.source === 'jira'));
  const simulated = latestSamples(samples.filter((sample) => sample.source === 'simulated'));
  const chosen = jiraSamples.length > 0 ? jiraSamples : simulated;
  const range = computeCapacity(chosen.map((sample) => sample.completedCount));
  if (chosen.length === 0) return { ...range, source: 'none', sourceLabel: 'No history' };
  const source = chosen[0].source;
  return { ...range, source, sourceLabel: source === 'jira' ? 'Jira sprint history' : 'Simulated history' };
}

/**
 * Cost-of-delay class of existing work (PRD: derived from linked goal/epic, not
 * from claims). Until goals are linked: due date or `fixed-date` label → fixed
 * date; `tech-debt` label or Low priority → intangible; otherwise standard.
 */
export function costClassOf(issue: JiraIssue): CostClass {
  const labels = issue.fields.labels ?? [];
  if (issue.fields.duedate || labels.includes('fixed-date')) return 'fixed-date';
  if (labels.includes('tech-debt') || issue.fields.priority?.name === 'Low') return 'intangible';
  return 'standard';
}

export function toWorkItem(issue: JiraIssue, sprintId?: string): WorkItem {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? issue.key,
    sprintId,
    dueDate: issue.fields.duedate ?? undefined,
    labels: issue.fields.labels ?? [],
    issueType: issue.fields.issuetype?.name ?? 'Unknown',
    priority: issue.fields.priority?.name ?? 'Medium',
    epicKey: issue.fields.parent?.key,
    costClass: costClassOf(issue),
  };
}

export interface SprintIssues {
  sprint: Sprint;
  issues: readonly JiraIssue[];
}

/**
 * Existing commitments (PRD): open issues in the active and next sprint, plus
 * open issues with a due date before `neededBy`. Deduplicated by key; sprint
 * membership wins over due-date-only membership.
 */
export function buildCommitments(
  sprints: readonly SprintIssues[],
  dueIssues: readonly JiraIssue[],
  neededBy?: IsoDate,
): WorkItem[] {
  const byKey = new Map<string, WorkItem>();
  for (const { sprint, issues } of sprints) {
    for (const issue of issues) {
      if (!isDone(issue) && !byKey.has(issue.key)) byKey.set(issue.key, toWorkItem(issue, sprint.id));
    }
  }
  for (const issue of dueIssues) {
    const due = issue.fields.duedate;
    if (isDone(issue) || byKey.has(issue.key) || !due) continue;
    if (neededBy && due >= neededBy) continue;
    byKey.set(issue.key, toWorkItem(issue));
  }
  return [...byKey.values()];
}

const DEFAULT_SPRINT_DAYS = 14;

function shiftDate(date: IsoDate, days: number): IsoDate {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Future sprints often have no dates in Jira. Missing dates are inferred from
 * the previous sprint (same length, starting the day after it ends).
 * Sprints that cannot be dated are dropped.
 */
export function withInferredDates(sprints: readonly JiraSprint[]): Sprint[] {
  const result: Sprint[] = [];
  for (const sprint of sprints) {
    const start = sprint.startDate?.slice(0, 10);
    const end = sprint.endDate?.slice(0, 10);
    if (start && end) {
      result.push({ id: String(sprint.id), name: sprint.name, startDate: start, endDate: end, state: sprint.state });
      continue;
    }
    const previous = result[result.length - 1];
    if (!previous) continue;
    const length =
      Math.round((Date.parse(previous.endDate) - Date.parse(previous.startDate)) / 86_400_000) || DEFAULT_SPRINT_DAYS;
    const startDate = shiftDate(previous.endDate, 1);
    result.push({ id: String(sprint.id), name: sprint.name, startDate, endDate: shiftDate(startDate, length), state: sprint.state });
  }
  return result;
}

/** Active sprint first, then the next future sprint (by start date). */
export function pickActiveAndNext(sprints: readonly Sprint[]): Sprint[] {
  const active = sprints.filter((sprint) => sprint.state === 'active');
  const future = sprints
    .filter((sprint) => sprint.state === 'future')
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  return [...active.slice(0, 1), ...future.slice(0, 1)];
}
