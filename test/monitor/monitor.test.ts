import { beforeEach, describe, expect, it } from 'vitest';
import {
  monitorProviderTeam,
  nearestContractProjection,
  type MonitorDeps,
  type MonitoredContract,
  type MonitorStore,
  type NotificationState,
} from '../../src/monitor/monitor';
import type { ContractStatus } from '../../src/negotiation/types';
import { projectContract, type Sprint, type WorkItem } from '../../src/planner';
import { MOB, PAY, request } from '../negotiation/fakes';

const SPRINTS: Sprint[] = [
  { id: '2', name: 'Payments Sprint 41', startDate: '2026-11-01', endDate: '2026-11-14', state: 'active' },
  { id: '4', name: 'Payments Sprint 42', startDate: '2026-11-15', endDate: '2026-11-28', state: 'future' },
];

const work = (key: string): WorkItem => ({ key, summary: key, labels: [], issueType: 'Story', priority: 'Medium', costClass: 'standard', sprintId: '2' });

class MemoryMonitorStore implements MonitorStore {
  contracts: MonitoredContract[] = [];
  auditLog: Array<{ entityType: string; entityId: string; action: string; payload: unknown }> = [];
  /** Simulates a concurrent run that changes the status between read and update. */
  loseNextTransition = false;

  async providersWithContracts() {
    return [...new Set(this.contracts.map((row) => row.request.providerTeamId))];
  }
  async contractsForProvider(teamId: string) {
    return this.contracts.filter((row) => row.request.providerTeamId === teamId).map((row) => ({ ...row, contract: { ...row.contract } }));
  }
  async saveEvaluation(contractId: number, from: ContractStatus, to: ContractStatus, projectedDate: string | null) {
    const row = this.contracts.find((r) => r.contract.id === contractId);
    if (!row || row.contract.status !== from) return false;
    if (this.loseNextTransition && from !== to) {
      this.loseNextTransition = false;
      row.contract.status = to;
      return false;
    }
    row.contract = { ...row.contract, status: to, projectedDate };
    return true;
  }
  /** Rows of contract_notifications; the unique key is contract + seq + issue. */
  notifications: Array<{ contractId: number; seq: number; status: ContractStatus; issueKey: string }> = [];

  async lastNotification(contractId: number): Promise<NotificationState | null> {
    const rows = this.notifications.filter((n) => n.contractId === contractId);
    if (rows.length === 0) return null;
    const seq = Math.max(...rows.map((n) => n.seq));
    const last = rows.filter((n) => n.seq === seq);
    return { seq, status: last[0].status, issueKeys: last.map((n) => n.issueKey) };
  }
  async claimNotification(contractId: number, seq: number, status: ContractStatus, _projectedDate: string | null, issueKey: string) {
    if (this.notifications.some((n) => n.contractId === contractId && n.seq === seq && n.issueKey === issueKey)) return false;
    this.notifications.push({ contractId, seq, status, issueKey });
    return true;
  }
  async audit(entityType: string, entityId: string, action: string, _actor: string | null, payload: unknown) {
    this.auditLog.push({ entityType, entityId, action, payload });
  }
}

function contractRow(id: number, deliverable: string, status: ContractStatus = 'on-track'): MonitoredContract {
  return {
    contract: {
      id,
      requestId: `req-0000000${id}-0000-4000-8000-000000000000`,
      optionId: id,
      deliverableIssueKey: deliverable,
      agreedDateMin: '2026-11-28',
      agreedDateMax: '2026-11-28',
      status,
      projectedDate: null,
    },
    request: request({ id: `req-0000000${id}-0000-4000-8000-000000000000`, sourceIssueKey: `MOB-${id + 1}`, status: 'contracted' }),
  };
}

describe('monitorProviderTeam', () => {
  let store: MemoryMonitorStore;
  let commitments: WorkItem[];
  let comments: Array<{ issueKey: string; text: string; mentions: readonly string[] }>;
  let failComments: boolean;
  let done: Set<string>;
  let deps: MonitorDeps;

  beforeEach(() => {
    store = new MemoryMonitorStore();
    store.contracts = [contractRow(1, 'PAY-12'), contractRow(2, 'PAY-13')];
    // 12 open issues plus both deliverables (which must not be counted twice)
    commitments = [...Array.from({ length: 12 }, (_, i) => work(`PAY-${100 + i}`)), work('PAY-12'), work('PAY-13')];
    comments = [];
    failComments = false;
    done = new Set();
    deps = {
      store,
      today: () => '2026-11-05',
      teams: {
        getTeam: async (id) => [MOB, PAY].find((team) => team.id === id) ?? null,
        capacity: async () => ({ pessimistic: 9, realistic: 10, samples: [9, 10], limitedData: true }),
        approvers: async (team) => [team.leadAccountId ?? ''],
      },
      jira: {
        commitments: async () => ({ sprints: SPRINTS, commitments }),
        doneIssueKeys: async (keys) => new Set(keys.filter((key) => done.has(key))),
        addComment: async (issueKey, text, mentions) => {
          if (failComments) throw new Error('HTTP 500');
          comments.push({ issueKey, text, mentions });
        },
      },
    };
  });

  const addBugs = () => commitments.push(work('PAY-200'), work('PAY-201'));
  const removeBugs = () => {
    commitments = commitments.filter((item) => !['PAY-200', 'PAY-201'].includes(item.key));
  };
  const statusOf = (id: number) => store.contracts.find((row) => row.contract.id === id)?.contract;

  it('keeps contracts on-track and stays silent when the plan still fits', async () => {
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.committedIssues).toBe(12);
    expect(result.evaluated.map((e) => [e.contractId, e.to, e.projectedDate, e.workAhead])).toEqual([
      [1, 'on-track', '2026-11-28', 15],
      [2, 'on-track', '2026-11-28', 18],
    ]);
    expect(comments).toEqual([]);
    expect(statusOf(2)?.projectedDate).toBe('2026-11-28');
  });

  it('marks the later contract at-risk after two extra bugs and notifies both issues once', async () => {
    addBugs();
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated.map((e) => [e.contractId, e.to, e.changed])).toEqual([
      [1, 'on-track', false],
      [2, 'at-risk', true],
    ]);
    expect(statusOf(2)).toMatchObject({ status: 'at-risk', projectedDate: '2026-12-12' });
    expect(comments.map((c) => c.issueKey)).toEqual(['MOB-3', 'PAY-13']);
    expect(comments[0].mentions).toEqual(['lead-mobile', 'lead-payments-project']);
    expect(comments[0].text).toContain('now at risk');
    expect(comments[0].text).toContain('2026-12-12');
    expect(store.auditLog.filter((e) => e.action === 'status-changed')).toHaveLength(1);

    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toHaveLength(2);
    expect(store.auditLog.filter((e) => e.action === 'status-changed')).toHaveLength(1);
  });

  it('returns to on-track when the bugs leave the sprint and comments once more', async () => {
    addBugs();
    await monitorProviderTeam(deps, PAY.id);
    removeBugs();
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated[1]).toMatchObject({ from: 'at-risk', to: 'on-track', changed: true });
    expect(comments.map((c) => c.issueKey)).toEqual(['MOB-3', 'PAY-13', 'MOB-3', 'PAY-13']);
    expect(comments[2].text).toContain('back on track');
    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toHaveLength(4);
  });

  it('notifies once when a crash happened after the status update and before any comment', async () => {
    addBugs();
    // Crash: the status column already says at-risk, but no notification was claimed.
    store.contracts[1].contract.status = 'at-risk';
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated[1]).toMatchObject({ from: 'at-risk', to: 'at-risk', changed: false });
    expect(comments.map((c) => c.issueKey)).toEqual(['MOB-3', 'PAY-13']);
    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toHaveLength(2);
  });

  it('resumes a partially claimed notification without posting twice', async () => {
    addBugs();
    store.contracts[1].contract.status = 'at-risk';
    store.notifications.push({ contractId: 2, seq: 1, status: 'at-risk', issueKey: 'MOB-3' });
    await monitorProviderTeam(deps, PAY.id);
    expect(comments.map((c) => c.issueKey)).toEqual(['PAY-13']);
    expect(store.notifications.filter((n) => n.contractId === 2)).toHaveLength(2);
  });

  it('posts nothing when every issue of the change was already claimed', async () => {
    addBugs();
    store.notifications.push(
      { contractId: 2, seq: 1, status: 'at-risk', issueKey: 'MOB-3' },
      { contractId: 2, seq: 1, status: 'at-risk', issueKey: 'PAY-13' },
    );
    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toEqual([]);
  });

  it('does not notify when another run won the status change', async () => {
    addBugs();
    store.loseNextTransition = true;
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated[1]).toMatchObject({ to: 'at-risk', changed: false });
    expect(comments).toEqual([]);
    expect(store.auditLog.filter((e) => e.action === 'status-changed')).toHaveLength(0);
  });

  it('keeps provider workload out of the requester comment', async () => {
    addBugs();
    await monitorProviderTeam(deps, PAY.id);
    const [requester, provider] = comments;
    expect(requester.issueKey).toBe('MOB-3');
    expect(requester.text).toContain('2026-12-12');
    expect(requester.text).toContain('2026-11-28 to 2026-11-28');
    expect(requester.text).not.toMatch(/issues are planned|pessimistic/);
    expect(provider.text).toContain('pessimistic 9 issues per sprint');
  });

  it.each([
    ['no capacity source', { pessimistic: 9, realistic: 10, samples: [], limitedData: true, source: 'none' }],
    ['zero pessimistic capacity', { pessimistic: 0, realistic: 0, samples: [0], limitedData: true, source: 'jira' }],
  ])('marks contracts unknown without comments on %s', async (_label, capacity) => {
    addBugs();
    store.contracts[1].contract.status = 'at-risk';
    deps.teams.capacity = async () => capacity;
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.enoughData).toBe(false);
    expect(result.evaluated.map((e) => [e.contractId, e.to, e.projectedDate])).toEqual([
      [1, 'unknown', null],
      [2, 'unknown', null],
    ]);
    expect(statusOf(2)?.status).toBe('unknown');
    expect(comments).toEqual([]);
    expect(store.notifications).toEqual([]);
  });

  it('counts every monitored contract of the provider as work ahead', async () => {
    store.contracts = Array.from({ length: 150 }, (_, i) => contractRow(i + 1, `PAY-${1000 + i}`));
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated).toHaveLength(150);
    // Each contract adds the same request size on top of the previous one, up to the 150th.
    expect(result.evaluated[149].workAhead).toBe(result.evaluated[0].workAhead + 149 * (result.evaluated[1].workAhead - result.evaluated[0].workAhead));
  });

  it('audits a failed comment and does not retry it', async () => {
    addBugs();
    failComments = true;
    await monitorProviderTeam(deps, PAY.id);
    expect(store.auditLog.filter((e) => e.action === 'comment-failed')).toHaveLength(2);
    failComments = false;
    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toEqual([]);
  });

  it('skips contracts whose deliverable is done and does not count them as earlier work', async () => {
    addBugs();
    done.add('PAY-12');
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.skippedDone).toEqual([1]);
    expect(result.evaluated).toHaveLength(1);
    expect(result.evaluated[0]).toMatchObject({ contractId: 2, to: 'on-track', workAhead: 17 });
  });

  it('counts bugs in the active sprint as work ahead of a deliverable that sits in the backlog', async () => {
    // one-atlas: the deliverable (PAY-13) is in no sprint, so it is not among the commitments at all.
    store.contracts = [contractRow(2, 'PAY-13')];
    commitments = commitments.filter((item) => item.key !== 'PAY-12' && item.key !== 'PAY-13');
    const before = await monitorProviderTeam(deps, PAY.id);
    expect(before.evaluated[0]).toMatchObject({ to: 'on-track', workAhead: 15 });
    commitments.push(work('PAY-200'), work('PAY-201'), work('PAY-202'), work('PAY-203'));
    const after = await monitorProviderTeam(deps, PAY.id);
    expect(after.evaluated[0]).toMatchObject({ to: 'at-risk', workAhead: 19, projectedDate: '2026-12-12' });
  });

  it('nearestContractProjection returns the monitor input of the earliest open contract', async () => {
    done.add('PAY-12');
    const nearest = await nearestContractProjection(deps, PAY.id);
    expect(nearest).toMatchObject({ contractId: 2, deliverableIssueKey: 'PAY-13', status: 'on-track' });
    expect(nearest?.committedKeys).toHaveLength(12);
    expect(nearest?.input).toMatchObject({ pessimistic: 9, committedIssues: 12, earlierContractSizes: [], agreedDateMax: '2026-11-28' });
    expect(projectContract(nearest!.input)).toMatchObject({ status: 'on-track', workAhead: 15 });
  });
});
