import { UserFacingError } from '../errors';
import { projectContract, type IsoDate, type ProjectionInput } from '../planner';
import type { NearestContractProjection } from '../monitor/monitor';
import { DEMO_PAYMENTS_CHARTER } from './scenario';
import { DEMO_LABEL, type DemoIssue } from './seed-data';

/** Label of every demo bug created by "Add critical bugs" (reset only touches these). */
export const DEMO_BUG_LABEL = 'accord-demo-bug';
/** Label of the demo bugs before 5.22; still found so older bugs are reused, not duplicated. */
export const LEGACY_DEMO_BUG_LABEL = 'accord-demo-critical';
/** Upper bound of demo bugs in the plan at once, so a click never floods the sprint. */
export const MAX_DEMO_BUGS = 8;
/** A second click within this window is refused while the first one is still creating issues. */
export const INTENT_GRACE_SECONDS = 30;

/** Red-line label of the Payments charter: the bugs are commitments the planner may never shift. */
const RED_LINE_LABELS = DEMO_PAYMENTS_CHARTER.redLines.filter((rule) => rule.field === 'label').map((rule) => rule.value);

const bug = (summary: string): DemoIssue => ({ summary, issueType: 'Bug', priority: 'Highest', labels: [DEMO_BUG_LABEL, ...RED_LINE_LABELS] });

/** Fixed catalogue: bugs are matched by summary, so a click never creates the same bug twice. */
export const CRITICAL_BUGS: readonly DemoIssue[] = [
  bug('Duplicate charge when a card payment is retried after a timeout'),
  bug('Refunds stuck in pending after a payment provider outage'),
  bug('Card tokens logged in plain text by the checkout service'),
  bug('Chargeback webhook rejects valid signatures after key rotation'),
  bug('Payout batch skips merchants with a negative balance'),
  bug('3-D Secure challenge loops on mobile browsers'),
  bug('Currency rounding error on partial refunds'),
  bug('Fraud rules engine times out under peak load'),
];

export interface DemoBugPort {
  /** Open (not Done) issues of the project with the demo bug label (key + summary). */
  findBugs(projectKey: string): Promise<Array<{ key: string; summary: string }>>;
  createBugs(projectKey: string, bugs: readonly DemoIssue[]): Promise<string[]>;
  /** Active sprint of the team board, null when there is none. */
  activeSprint(projectKey: string): Promise<{ id: number; name: string } | null>;
  /** The provider's open contract with the earliest agreed date, as the monitor projects it. */
  nearestContract(projectKey: string): Promise<NearestContractProjection | null>;
  moveToSprint(sprintId: number, issueKeys: readonly string[]): Promise<void>;
  moveToBacklog(issueKeys: readonly string[]): Promise<void>;
  /** Queues the monitor for this provider team so the new status shows without another click. */
  queueMonitor(projectKey: string): Promise<void>;
  /** Seconds since the last `demo-bugs-intent` audit entry; null when none. */
  lastIntentAgeSeconds(): Promise<number | null>;
  audit(action: string, actor: string | null, payload: unknown): Promise<void>;
}

export interface DemoBugsResult {
  projectKey: string;
  sprintId: number | null;
  sprintName: string | null;
  /** Bugs put into the active sprint by this call (reused from the backlog or created). */
  added: string[];
  created: string[];
  /** Demo bugs that were already in the plan before this call. */
  existing: string[];
  deliverableIssueKey: string | null;
  agreedDateMax: IsoDate | null;
  projectedBefore: IsoDate | null;
  /** Projection with the added bugs (null = beyond the planning horizon). */
  projectedAfter: IsoDate | null;
  monitorQueued: boolean;
}

/**
 * Smallest number of extra one-issue commitments that makes the projection miss the agreed latest
 * date (0 when it already does); null when even `max` extra issues keep it on track.
 */
export function bugsUntilAtRisk(input: ProjectionInput, max: number): number | null {
  for (let extra = 0; extra <= max; extra += 1) {
    if (projectContract({ ...input, committedIssues: input.committedIssues + extra }).status === 'at-risk') return extra;
  }
  return null;
}

const withExtra = (input: ProjectionInput, extra: number) =>
  projectContract({ ...input, committedIssues: input.committedIssues + extra }).projectedDate;

/**
 * Adds just enough Highest-priority demo bugs to the active sprint to put the provider's nearest
 * contract at risk, then queues the monitor. Idempotent: demo bugs already in the plan count, bugs
 * in the backlog are moved back before new ones are created, and a second click only adds the gap.
 */
export async function addDemoBugs(port: DemoBugPort, projectKey: string, actor: string | null): Promise<DemoBugsResult> {
  const sprint = await port.activeSprint(projectKey);
  if (sprint === null) {
    throw new UserFacingError(`${projectKey} has no active sprint yet. Run the demo setup (sprints step) first.`);
  }
  const target = await port.nearestContract(projectKey);
  if (target === null) {
    throw new UserFacingError(`${projectKey} has no active contract with capacity data yet. Approve a deal with ${projectKey} as the provider first.`);
  }
  const found = await port.findBugs(projectKey);
  const planned = new Set(target.committedKeys);
  const existing = found.filter((issue) => planned.has(issue.key)).map((issue) => issue.key);
  const needed = bugsUntilAtRisk(target.input, MAX_DEMO_BUGS - existing.length);
  if (needed === null) {
    throw new UserFacingError(
      `Even ${MAX_DEMO_BUGS} critical bugs would not put ${target.deliverableIssueKey ?? 'the contract'} at risk; ${projectKey} has too much spare capacity.`,
    );
  }
  const reused = found.filter((issue) => !planned.has(issue.key)).slice(0, needed).map((issue) => issue.key);
  const known = new Set(found.map((issue) => issue.summary));
  const missing = CRITICAL_BUGS.filter((item) => !known.has(item.summary)).slice(0, needed - reused.length);
  let created: string[] = [];
  if (missing.length > 0) {
    // Jira search is eventually consistent: a bug created seconds ago may not be found yet.
    const age = await port.lastIntentAgeSeconds();
    if (age !== null && age < INTENT_GRACE_SECONDS) {
      throw new UserFacingError('The demo bugs are already being added. Try again in half a minute.');
    }
    await port.audit('demo-bugs-intent', actor, { missing: missing.map((item) => item.summary) });
    created = await port.createBugs(
      projectKey,
      missing.map((item) => ({ ...item, labels: [DEMO_LABEL, ...item.labels] })),
    );
  }
  const added = [...reused, ...created];
  if (added.length > 0) await port.moveToSprint(sprint.id, added);
  await port.queueMonitor(projectKey);
  const result: DemoBugsResult = {
    projectKey,
    sprintId: sprint.id,
    sprintName: sprint.name,
    added,
    created,
    existing,
    deliverableIssueKey: target.deliverableIssueKey,
    agreedDateMax: target.input.agreedDateMax,
    projectedBefore: withExtra(target.input, 0),
    projectedAfter: withExtra(target.input, added.length),
    monitorQueued: true,
  };
  await port.audit('demo-bugs-added', actor, result);
  return result;
}

/** Moves the open demo bugs to the backlog (never deleted) and queues the monitor again. */
export async function resetDemoBugs(port: DemoBugPort, projectKey: string, actor: string | null) {
  const moved = (await port.findBugs(projectKey)).map((issue) => issue.key);
  if (moved.length > 0) await port.moveToBacklog(moved);
  await port.queueMonitor(projectKey);
  await port.audit('demo-bugs-reset', actor, { moved });
  return { projectKey, moved, monitorQueued: true };
}
