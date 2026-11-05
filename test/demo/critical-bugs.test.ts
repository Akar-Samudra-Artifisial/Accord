import { beforeEach, describe, expect, it } from 'vitest';
import {
  CRITICAL_BUGS,
  MAX_DEMO_BUGS,
  addDemoBugs,
  bugsUntilAtRisk,
  resetDemoBugs,
  type DemoBugPort,
} from '../../src/demo/critical-bugs';
import { UserFacingError } from '../../src/errors';
import type { NearestContractProjection } from '../../src/monitor/monitor';
import { projectContract, type ProjectionInput } from '../../src/planner';

const SPRINT = { id: 2, name: 'Payments Sprint 41' };

/**
 * one-atlas-vyyd before the fix: pessimistic 9 per sprint, 12 open committed issues, an M contract
 * (3 issues) due by the end of the next sprint. Two bugs still fit (17 ≤ 18 issues in two sprints).
 */
const BASE: ProjectionInput = {
  sprints: [
    { id: '2', name: 'Payments Sprint 41', startDate: '2026-11-02', endDate: '2026-11-15', state: 'active' },
    { id: '3', name: 'Payments Sprint 42', startDate: '2026-11-16', endDate: '2026-11-29', state: 'future' },
  ],
  today: '2026-11-05',
  pessimistic: 9,
  committedIssues: 12,
  earlierContractSizes: [],
  size: 'M',
  agreedDateMax: '2026-11-29',
};

class FakeBugPort implements DemoBugPort {
  issues: Array<{ key: string; summary: string; labels: string[]; priority: string; issueType: string; sprint: number | null }> = [];
  /** Issues created but not yet visible to search (eventual consistency). */
  hidden = new Set<string>();
  sprint: { id: number; name: string } | null = SPRINT;
  hasContract = true;
  base: ProjectionInput = BASE;
  intentAge: number | null = null;
  monitorRuns = 0;
  auditLog: Array<{ action: string; payload: unknown }> = [];
  projectKeys = new Set<string>();
  private next = 300;

  /** Projection the monitor would make now: base commitments plus the demo bugs in a sprint. */
  projection(): ProjectionInput {
    return { ...this.base, committedIssues: this.base.committedIssues + this.issues.filter((i) => i.sprint !== null).length };
  }

  async findBugs(projectKey: string) {
    this.projectKeys.add(projectKey);
    return this.issues.filter((i) => !this.hidden.has(i.key)).map(({ key, summary }) => ({ key, summary }));
  }
  async createBugs(projectKey: string, bugs: readonly { summary: string; labels: string[]; priority: string; issueType: string }[]) {
    this.projectKeys.add(projectKey);
    return bugs.map((bug) => {
      const key = `${projectKey}-${this.next++}`;
      this.issues.push({ key, ...bug, sprint: null });
      return key;
    });
  }
  async activeSprint(projectKey: string) {
    this.projectKeys.add(projectKey);
    return this.sprint;
  }
  async nearestContract(projectKey: string): Promise<NearestContractProjection | null> {
    this.projectKeys.add(projectKey);
    if (!this.hasContract) return null;
    return {
      contractId: 1,
      deliverableIssueKey: `${projectKey}-13`,
      status: 'on-track',
      committedKeys: this.issues.filter((i) => i.sprint !== null).map((i) => i.key),
      input: this.projection(),
    };
  }
  async moveToSprint(sprintId: number, keys: readonly string[]) {
    for (const issue of this.issues) if (keys.includes(issue.key)) issue.sprint = sprintId;
  }
  async moveToBacklog(keys: readonly string[]) {
    for (const issue of this.issues) if (keys.includes(issue.key)) issue.sprint = null;
  }
  async queueMonitor() {
    this.monitorRuns += 1;
  }
  async lastIntentAgeSeconds() {
    return this.intentAge;
  }
  async audit(action: string, _actor: string | null, payload: unknown) {
    if (action === 'demo-bugs-intent') this.intentAge = 0;
    this.auditLog.push({ action, payload });
  }

  status() {
    return projectContract(this.projection());
  }
}

describe('bugsUntilAtRisk', () => {
  it('finds the smallest number of extra issues that misses the agreed date', () => {
    expect(bugsUntilAtRisk(BASE, 8)).toBe(4);
    expect(bugsUntilAtRisk({ ...BASE, committedIssues: 16 }, 8)).toBe(0);
    expect(bugsUntilAtRisk({ ...BASE, pessimistic: 30 }, 8)).toBeNull();
  });
});

describe('demo critical bugs', () => {
  let port: FakeBugPort;
  beforeEach(() => {
    port = new FakeBugPort();
  });

  it('adds just enough Highest red-line bugs to the active sprint to put the contract at risk, then queues the monitor', async () => {
    expect(port.status().status).toBe('on-track');
    const result = await addDemoBugs(port, 'ACPAY', 'lead');
    expect(result.created).toEqual(['ACPAY-300', 'ACPAY-301', 'ACPAY-302', 'ACPAY-303']);
    expect(result).toMatchObject({ sprintName: 'Payments Sprint 41', projectedBefore: '2026-11-29', agreedDateMax: '2026-11-29' });
    expect(result.projectedAfter! > '2026-11-29').toBe(true);
    expect(port.status().status).toBe('at-risk');
    expect(port.issues.every((i) => i.priority === 'Highest' && i.issueType === 'Bug' && i.sprint === SPRINT.id)).toBe(true);
    expect(port.issues[0].labels).toEqual(['accord-demo', 'accord-demo-bug', 'security']);
    expect(port.issues.map((i) => i.summary)).toEqual(CRITICAL_BUGS.slice(0, 4).map((b) => b.summary));
    expect(port.monitorRuns).toBe(1);
    expect([...port.projectKeys]).toEqual(['ACPAY']);
  });

  it('is idempotent: a second click adds nothing once the contract is at risk', async () => {
    await addDemoBugs(port, 'PAY', 'lead');
    port.intentAge = 120;
    const second = await addDemoBugs(port, 'PAY', 'lead');
    expect(second.added).toEqual([]);
    expect(second.existing).toHaveLength(4);
    expect(port.issues).toHaveLength(4);
    expect(port.monitorRuns).toBe(2);
  });

  it('only adds the shortfall when some demo bugs already exist (e.g. the two from an older version)', async () => {
    await port.createBugs('PAY', CRITICAL_BUGS.slice(0, 2).map((b) => ({ ...b })));
    await port.moveToSprint(SPRINT.id, ['PAY-300', 'PAY-301']);
    const result = await addDemoBugs(port, 'PAY', 'lead');
    expect(result.existing).toEqual(['PAY-300', 'PAY-301']);
    expect(result.created).toEqual(['PAY-302', 'PAY-303']);
    expect(port.status().status).toBe('at-risk');
  });

  it('refuses a double click while the new bugs are not searchable yet', async () => {
    await addDemoBugs(port, 'PAY', 'lead');
    port.issues.forEach((i) => port.hidden.add(i.key));
    port.base = { ...BASE, committedIssues: 0 };
    await expect(addDemoBugs(port, 'PAY', 'lead')).rejects.toBeInstanceOf(UserFacingError);
    expect(port.issues).toHaveLength(4);
  });

  it('never goes beyond the cap when the provider has too much spare capacity', async () => {
    port.base = { ...BASE, pessimistic: 30 };
    await expect(addDemoBugs(port, 'PAY', 'lead')).rejects.toThrow(new RegExp(`Even ${MAX_DEMO_BUGS} critical bugs`));
    expect(port.issues).toEqual([]);
  });

  it('requires an active sprint and an active contract', async () => {
    port.sprint = null;
    await expect(addDemoBugs(port, 'PAY', 'lead')).rejects.toThrow(/no active sprint/);
    port.sprint = SPRINT;
    port.hasContract = false;
    await expect(addDemoBugs(port, 'PAY', 'lead')).rejects.toThrow(/no active contract/);
    expect(port.issues).toEqual([]);
  });

  it('reset moves the bugs to the backlog (back on track) and add brings the same bugs back', async () => {
    await addDemoBugs(port, 'PAY', 'lead');
    const reset = await resetDemoBugs(port, 'PAY', 'lead');
    expect(reset.moved).toEqual(['PAY-300', 'PAY-301', 'PAY-302', 'PAY-303']);
    expect(port.issues.every((i) => i.sprint === null)).toBe(true);
    expect(port.status().status).toBe('on-track');
    expect(port.monitorRuns).toBe(2);
    port.intentAge = 120;
    const again = await addDemoBugs(port, 'PAY', 'lead');
    expect(again.created).toEqual([]);
    expect(again.added).toEqual(['PAY-300', 'PAY-301', 'PAY-302', 'PAY-303']);
    expect(port.issues.every((i) => i.sprint === SPRINT.id)).toBe(true);
  });
});
