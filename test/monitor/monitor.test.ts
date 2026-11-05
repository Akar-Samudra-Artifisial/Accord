import { beforeEach, describe, expect, it } from 'vitest';
import {
  monitorProviderTeam,
  nearestContractProjection,
  providerWorkAhead,
  type MonitorDeps,
  type MonitoredContract,
  type MonitorStore,
  type NotificationState,
} from '../../src/monitor/monitor';
import { APP_CREATOR, type ContractStatus } from '../../src/negotiation/types';
import {
  applyContract,
  cancelRenegotiationsBackOnTrack,
  decide,
  openRenegotiation,
  runRound1,
  runRound2,
  type RenegotiationTrigger,
} from '../../src/negotiation/orchestrator';
import { projectContract, type Sprint, type WorkItem } from '../../src/planner';
import { MOB, PAY, harness, request } from '../negotiation/fakes';

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
  /** Request id of a renegotiation → projected date of the contract it replaced. */
  baselines = new Map<string, string | null>();
  async renegotiationBaseline(requestId: string) {
    return this.baselines.has(requestId) ? { projectedDate: this.baselines.get(requestId) ?? null } : null;
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
      renegotiate: async (trigger) => {
        triggers.push(trigger);
        return { status: 'opened', requestId: 'req-renegotiation', detail: '' };
      },
      cancelRenegotiations: async () => ({ cancelled: [], announced: false }),
    };
    triggers = [];
  });

  let triggers: RenegotiationTrigger[] = [];

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
    expect(comments[0].text).toContain('Dec 12, 2026');
    expect(store.auditLog.filter((e) => e.action === 'status-changed')).toHaveLength(1);

    await monitorProviderTeam(deps, PAY.id);
    expect(comments).toHaveLength(2);
    expect(store.auditLog.filter((e) => e.action === 'status-changed')).toHaveLength(1);
  });

  it('opens exactly one renegotiation as the app when a contract goes at risk, even after two runs (FR-14)', async () => {
    const h = harness();
    const parent = store.contracts[1];
    await h.store.insertRequest({ ...parent.request });
    h.store.contracts.push({ ...parent.contract });
    let next = 0;
    deps.renegotiate = (trigger) => openRenegotiation(h.deps, trigger, `req-00000000-0000-4000-8000-00000000000${++next}`);
    addBugs();
    const first = await monitorProviderTeam(deps, PAY.id);
    expect(first.renegotiations).toEqual([expect.objectContaining({ contractId: 2, status: 'opened' })]);
    const second = await monitorProviderTeam(deps, PAY.id);
    expect(second.renegotiations).toEqual([expect.objectContaining({ contractId: 2, status: 'exists' })]);

    const opened = [...h.store.requests.values()].filter((r) => r.createdBy === APP_CREATOR);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ sourceIssueKey: 'MOB-3', providerTeamId: PAY.id, status: 'negotiating' });
    const audit = h.store.auditLog.filter((e) => e.action === 'renegotiation-opened');
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      as: 'app',
      episode: 1,
      note: 'Renegotiation: contract PAY-13 → MOB-3 at risk; projected finish Dec 12, 2026',
    });
    // Only the monitor's risk comments; the renegotiation comment comes with its deal sheet (round 2).
    expect(comments).toHaveLength(2);
  });

  it('regression: critical bugs → renegotiation → apply → the new contract is on track and not renegotiated again (FR-14, NFR-1)', async () => {
    // Two Low-priority (shiftable) stories in the next sprint, so the planner can also offer a shift.
    commitments = [
      ...Array.from({ length: 10 }, (_, i) => work(`PAY-${100 + i}`)),
      { ...work('PAY-120'), priority: 'Low', sprintId: '4' },
      { ...work('PAY-121'), priority: 'Low', sprintId: '4' },
      work('PAY-12'),
      work('PAY-13'),
    ];
    const h = harness({ sprints: SPRINTS, commitments: commitments.filter((item) => !['PAY-12', 'PAY-13'].includes(item.key)) });
    for (const row of store.contracts) {
      await h.store.insertRequest({ ...row.request });
      h.store.contracts.push({ ...row.contract });
    }
    h.deps.monitor.workAhead = (teamId, contractId) => providerWorkAhead(deps, teamId, contractId);
    const renegotiationId = 'req-00000000-0000-4000-8000-0000000000f1';
    deps.renegotiate = (trigger) => openRenegotiation(h.deps, trigger, renegotiationId);

    // Two Highest-priority bugs in the active sprint.
    commitments.push(
      { ...work('PAY-200'), issueType: 'Bug', priority: 'Highest' },
      { ...work('PAY-201'), issueType: 'Bug', priority: 'Highest' },
    );
    const risky = await monitorProviderTeam(deps, PAY.id);
    expect(risky.renegotiations).toEqual([expect.objectContaining({ contractId: 2, status: 'opened' })]);
    // One comment per issue: the risk and the opened renegotiation together.
    expect(comments.map((c) => c.issueKey)).toEqual(['MOB-3', 'PAY-13']);
    expect(comments[0].text).toContain('now at risk');
    expect(comments[0].text).toContain('Accord opened a renegotiation');

    await runRound1(h.deps, renegotiationId);
    await runRound2(h.deps, renegotiationId);
    const options = await h.store.listOptions(renegotiationId);
    expect(options.length).toBeGreaterThanOrEqual(2);
    // The monitor's comment already announced the renegotiation: round 2 adds no second one on MOB-3.
    expect(h.jira.comments.filter((c) => c.issueKey === 'MOB-3' && c.text.includes('renegotiation'))).toEqual([]);
    const projected = statusOf(2)?.projectedDate ?? '';
    const broker = await h.store.getRound(renegotiationId, 2, 'broker');
    const recommended = (broker?.output as { recommendedOptionId: number }).recommendedOptionId;
    await decide(h.deps, { requestId: renegotiationId, optionId: recommended, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    await decide(h.deps, { requestId: renegotiationId, optionId: recommended, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
    expect((await applyContract(h.deps, renegotiationId)).status).toBe('done');
    const applied = await h.store.getContract(renegotiationId);
    const appliedRequest = await h.store.getRequest(renegotiationId);
    if (!applied || !appliedRequest) throw new Error('renegotiated contract missing');

    // The monitor now sees the new contract instead of the superseded one; the planner's shifts moved issues.
    store.contracts[1].contract.status = 'superseded';
    store.contracts.push({ contract: { ...applied }, request: appliedRequest });
    store.baselines.set(renegotiationId, projected);
    const moved = new Map(h.jira.sprintMoves.flatMap((move) => move.keys.map((key) => [key, move.sprintId] as const)));
    const backlog = new Set(h.jira.backlogMoves.flat());
    commitments = commitments
      .filter((item) => !backlog.has(item.key))
      .filter((item) => !moved.has(item.key) || ['2', '4'].includes(moved.get(item.key) ?? ''));
    const after = await monitorProviderTeam(deps, PAY.id);
    expect(after.evaluated.find((e) => e.contractId === applied.id)).toMatchObject({ to: 'on-track' });
    expect(after.renegotiations).toEqual([]);
    expect(comments).toHaveLength(2);
    expect([...h.store.requests.values()].filter((r) => r.createdBy === APP_CREATOR)).toHaveLength(1);
  });

  it('holds an applied renegotiation at risk on the same projection and renegotiates once it gets worse', async () => {
    const renegotiated = contractRow(3, 'PAY-13');
    store.contracts = [contractRow(1, 'PAY-12'), { ...renegotiated, contract: { ...renegotiated.contract, agreedDateMin: '2026-11-28', agreedDateMax: '2026-11-28' } }];
    store.baselines.set(renegotiated.request.id, '2026-12-12');
    addBugs();
    const held = await monitorProviderTeam(deps, PAY.id);
    expect(held.evaluated[1]).toMatchObject({ contractId: 3, to: 'at-risk', projectedDate: '2026-12-12' });
    expect(held.held).toEqual([3]);
    expect(triggers).toEqual([]);
    expect(comments).toEqual([]);
    expect(store.auditLog.filter((e) => e.action === 'renegotiation-held')).toHaveLength(1);

    // New data: the projection moves past the baseline.
    commitments.push(...Array.from({ length: 9 }, (_, i) => work(`PAY-${400 + i}`)));
    const worse = await monitorProviderTeam(deps, PAY.id);
    expect(worse.held).toEqual([]);
    // Contract 1 goes at risk on the same new data; contract 3 is renegotiated again.
    expect(worse.renegotiations).toContainEqual(expect.objectContaining({ contractId: 3, status: 'opened' }));
    expect(triggers.map((t) => t.contract.id)).toContain(3);
    expect(comments.map((c) => c.issueKey)).toContain('MOB-4');
  });

  it('does not hold a renegotiated contract that was on track since apply: new data opens a renegotiation', async () => {
    const renegotiated = contractRow(3, 'PAY-13');
    store.contracts = [contractRow(1, 'PAY-12'), { ...renegotiated, contract: { ...renegotiated.contract, projectedDate: '2026-11-28' } }];
    store.baselines.set(renegotiated.request.id, '2026-12-12');
    addBugs();
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.held).toEqual([]);
    expect(result.renegotiations).toEqual([expect.objectContaining({ contractId: 3, status: 'opened' })]);
  });

  it('opens at most two renegotiations per run, nearest agreed date first, and the rest on the next run', async () => {
    const dated = (id: number, agreed: string) => {
      const row = contractRow(id, `PAY-${20 + id}`);
      return { ...row, contract: { ...row.contract, agreedDateMin: agreed, agreedDateMax: agreed } };
    };
    store.contracts = [dated(1, '2026-11-27'), dated(2, '2026-11-13'), dated(3, '2026-11-20'), dated(4, '2026-11-10')];
    commitments = Array.from({ length: 40 }, (_, i) => work(`PAY-${300 + i}`));
    const openedFor = new Set<number>();
    deps.renegotiate = async (trigger) => {
      const exists = openedFor.has(trigger.contract.id);
      openedFor.add(trigger.contract.id);
      return { status: exists ? 'exists' : 'opened', requestId: `req-${trigger.contract.id}`, detail: '' };
    };
    const first = await monitorProviderTeam(deps, PAY.id);
    expect(first.evaluated.every((e) => e.to === 'at-risk')).toBe(true);
    expect(first.renegotiations.map((r) => [r.contractId, r.status])).toEqual([
      [4, 'opened'],
      [2, 'opened'],
      [3, 'deferred'],
      [1, 'deferred'],
    ]);
    const second = await monitorProviderTeam(deps, PAY.id);
    expect(second.renegotiations.map((r) => [r.contractId, r.status])).toEqual([
      [4, 'exists'],
      [2, 'exists'],
      [3, 'opened'],
      [1, 'opened'],
    ]);
  });

  it('does not renegotiate on-track contracts and keeps monitoring when the opener fails', async () => {
    await monitorProviderTeam(deps, PAY.id);
    expect(triggers).toEqual([]);
    addBugs();
    deps.renegotiate = async () => {
      throw new Error('queue down');
    };
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated[1]).toMatchObject({ to: 'at-risk', changed: true });
    expect(result.renegotiations).toEqual([expect.objectContaining({ contractId: 2, status: 'skipped' })]);
    expect(store.auditLog.find((e) => e.action === 'renegotiation-failed')?.payload).toMatchObject({ error: 'queue down' });
    expect(comments).toHaveLength(2);
  });

  it('ignores superseded contracts (FR-14)', async () => {
    store.contracts[1].contract.status = 'superseded';
    addBugs();
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated.map((e) => e.contractId)).toEqual([1]);
    expect(statusOf(2)?.status).toBe('superseded');
    expect(triggers).toEqual([]);
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

  it('cancels the undecided renegotiation once the contract is back on track, naming a lead that already approved', async () => {
    const h = harness();
    const parent = store.contracts[1];
    await h.store.insertRequest({ ...parent.request });
    h.store.contracts.push({ ...parent.contract });
    const renegotiationId = 'req-00000000-0000-4000-8000-0000000000c1';
    deps.renegotiate = (trigger) => openRenegotiation(h.deps, trigger, renegotiationId);
    deps.cancelRenegotiations = (contract, parentRequest) => cancelRenegotiationsBackOnTrack(h.deps, parentRequest, contract.id);
    addBugs();
    await monitorProviderTeam(deps, PAY.id);
    // The requester lead already approved an option; the provider has not decided yet.
    await h.store.transition(renegotiationId, ['negotiating'], 'awaiting-approval');
    h.store.approvals.push({
      id: 99,
      requestId: renegotiationId,
      optionId: 1,
      teamId: MOB.id,
      actorAccountId: 'lead-mobile',
      decision: 'approve',
      reason: null,
      createdAt: '',
    });

    removeBugs();
    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.cancelledRenegotiations).toEqual([renegotiationId]);
    expect((await h.store.getRequest(renegotiationId))?.status).toBe('cancelled');
    const audit = h.store.auditLog.filter((e) => e.action === 'renegotiation-cancelled');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: renegotiationId, actor: null });
    expect(audit[0].payload).toMatchObject({
      reason: 'Contract back on track',
      as: 'app',
      contractId: 2,
      approvedBy: [{ teamId: MOB.id, accountId: 'lead-mobile', name: 'Mia Mobile' }],
    });
    // No extra comment: the on-track comment on the source issue says it in one sentence; the deliverable stays plain.
    expect(comments.map((c) => c.issueKey)).toEqual(['MOB-3', 'PAY-13', 'MOB-3', 'PAY-13']);
    expect(comments[2].text).toContain('back on track');
    expect(comments[2].text).toContain('renegotiation is no longer needed and was cancelled');
    expect(comments[3].text).not.toContain('renegotiation');

    const again = await monitorProviderTeam(deps, PAY.id);
    expect(again.cancelledRenegotiations).toEqual([]);
    expect(comments).toHaveLength(4);
    expect(h.store.auditLog.filter((e) => e.action === 'renegotiation-cancelled')).toHaveLength(1);
  });

  it('keeps a renegotiation both leads approved, and does not mention an unannounced one', async () => {
    const h = harness();
    const parent = store.contracts[1];
    await h.store.insertRequest({ ...parent.request });
    const approved = 'req-00000000-0000-4000-8000-0000000000c2';
    const silent = 'req-00000000-0000-4000-8000-0000000000c3';
    for (const [id, status, episode] of [[approved, 'approved', 1], [silent, 'negotiating', 2]] as const) {
      h.store.renegotiations.push({ requestId: id, parentRequestId: parent.request.id, contractId: 2, episode });
      h.store.requests.set(id, { ...parent.request, id, status, createdBy: APP_CREATOR });
    }
    const outcome = await cancelRenegotiationsBackOnTrack(h.deps, parent.request, 2);
    expect(outcome).toEqual({ cancelled: [silent], announced: false });
    expect((await h.store.getRequest(approved))?.status).toBe('approved');
    expect(h.store.auditLog.find((e) => e.action === 'renegotiation-cancelled')?.payload).toMatchObject({ approvedBy: [] });
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
    expect(requester.text).toContain('Dec 12, 2026');
    expect(requester.text).toContain('the agreed date is Nov 28, 2026');
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
