import { describe, expect, it, vi } from 'vitest';

/**
 * In-memory Jira/SQL behind the real seed steps (`runSeedStep`): the board, issues, charter and history
 * below are exactly what "Seed demo data" writes on a fresh site.
 */
const seeded = vi.hoisted(() => ({
  issues: new Map<string, { summary: string; issueType: string; priority: string; labels: string[]; dueDate?: string }>(),
  sprints: [] as Array<{ id: number; name: string; state: 'closed' | 'active' | 'future'; startDate?: string; endDate?: string }>,
  sprintOf: new Map<string, number>(),
  charters: new Map<string, unknown>(),
  samples: new Map<string, Array<{ completedCount: number; endDate: string; source: string }>>(),
  nextKey: new Map<string, number>(),
}));

vi.mock('@forge/api', () => ({
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
}));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));
vi.mock('../../src/atlassian/http', async () => {
  const actual = await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http');
  // Both demo projects exist and carry the accord.demo property (the project step ran).
  return { ...actual, jira: vi.fn(async () => ({ key: 'accord.demo', value: { createdBy: 'accord' } })) };
});
vi.mock('../../src/teams/repository', () => ({
  getTeamByKey: vi.fn(async (key: string) => ({
    id: `team-${key}`,
    teamKey: key,
    name: key === 'PAY' ? 'Payments' : 'Mobile',
    jiraProjectKey: key,
    boardId: key === 'PAY' ? 2 : 1,
    leadAccountId: key === 'PAY' ? 'lead-payments' : 'lead-mobile',
  })),
  saveThroughput: vi.fn(async (teamId: string, samples: Array<{ completedCount: number; endDate: string; source: string }>) => {
    seeded.samples.set(teamId, [...samples]);
  }),
}));
vi.mock('../../src/teams/service', () => ({
  getProject: vi.fn(async (key: string) => ({ key, name: key })),
  registerTeam: vi.fn(),
  createCharterPage: vi.fn(async (team: { teamKey: string }, template: unknown) => {
    seeded.charters.set(team.teamKey, template);
    return { pageId: '1', created: true, charter: { valid: true, missingFields: [] } };
  }),
  resolveCharterSpace: vi.fn(async () => ({ key: 'ACCORD', state: 'accord', space: null })),
  TeamSetupError: class extends Error {},
}));
vi.mock('../../src/jira/issues', async () => {
  const actual = await vi.importActual<typeof import('../../src/jira/issues')>('../../src/jira/issues');
  return {
    ...actual,
    searchIssues: vi.fn(async () => []),
    listSprintIssues: vi.fn(async (sprintId: number) => [...seeded.sprintOf].filter(([, id]) => id === sprintId)),
    createIssues: vi.fn(async (issues: Array<{ projectKey: string; summary: string; issueType: string; priority: string; labels: string[]; dueDate?: string }>) =>
      issues.map((issue) => {
        // Jira numbers issues per project.
        const number = (seeded.nextKey.get(issue.projectKey) ?? 0) + 1;
        seeded.nextKey.set(issue.projectKey, number);
        const key = `${issue.projectKey}-${number}`;
        seeded.issues.set(key, { summary: issue.summary, issueType: issue.issueType, priority: issue.priority, labels: issue.labels, dueDate: issue.dueDate });
        return key;
      }),
    ),
  };
});
vi.mock('../../src/jira/sprints', async () => {
  const actual = await vi.importActual<typeof import('../../src/jira/sprints')>('../../src/jira/sprints');
  return {
    ...actual,
    listSprints: vi.fn(async (boardId: number) => seeded.sprints.filter((sprint) => Math.floor(sprint.id / 100) === boardId)),
    createSprint: vi.fn(async (boardId: number, name: string, startDate?: string, endDate?: string) => {
      const sprint = { id: boardId * 100 + seeded.sprints.length + 1, name, state: 'future' as const, startDate, endDate };
      seeded.sprints.push(sprint);
      return sprint;
    }),
    updateSprint: vi.fn(async (id: number, patch: Record<string, string>) => {
      const sprint = seeded.sprints.find((s) => s.id === id)!;
      Object.assign(sprint, patch);
      return sprint;
    }),
    moveIssuesToSprint: vi.fn(async (sprintId: number, keys: readonly string[]) => {
      for (const key of keys) seeded.sprintOf.set(key, sprintId);
    }),
  };
});

import {
  monitorProviderTeam,
  nearestContractProjection,
  providerWorkAhead,
  type MonitorDeps,
  type MonitoredContract,
  type MonitorStore,
  type NotificationState,
} from '../../src/monitor/monitor';
import { applyContract, decide, openRenegotiation, runRound1, runRound2 } from '../../src/negotiation/orchestrator';
import type { ContractStatus } from '../../src/negotiation/types';
import type { Charter, Sprint, WorkItem } from '../../src/planner';
import { capacityFromSamples, toWorkItem } from '../../src/capacity/aggregate';
import { toPlannerSprint } from '../../src/jira/sprints';
import type { JiraIssue } from '../../src/jira/issues';
import type { ThroughputSample } from '../../src/capacity/aggregate';
import type { CharterTemplateInput } from '../../src/confluence/charter';
import { runSeedStep, type SeedContext } from '../../src/demo/seed';
import { DEMO_LABEL, DEMO_TEAMS, SEED_STEPS, addDaysIso } from '../../src/demo/seed-data';
import { CRITICAL_BUGS, bugsUntilAtRisk } from '../../src/demo/critical-bugs';
import { MOB, PAY, REQUEST_ID, harness, request } from '../negotiation/fakes';

/** The judge path on a fresh site: "Seed demo data" run today, then a request from MOB to Payments. */
const TODAY = '2026-11-05';

class MemoryMonitorStore implements MonitorStore {
  contracts: MonitoredContract[] = [];
  notifications: Array<{ contractId: number; seq: number; status: ContractStatus; issueKey: string }> = [];
  async providersWithContracts() {
    return [...new Set(this.contracts.map((row) => row.request.providerTeamId))];
  }
  async contractsForProvider(teamId: string) {
    return this.contracts.filter((row) => row.request.providerTeamId === teamId).map((row) => ({ ...row, contract: { ...row.contract } }));
  }
  async saveEvaluation(contractId: number, from: ContractStatus, to: ContractStatus, projectedDate: string | null) {
    const row = this.contracts.find((r) => r.contract.id === contractId);
    if (!row || row.contract.status !== from) return false;
    row.contract = { ...row.contract, status: to, projectedDate };
    return true;
  }
  async lastNotification(contractId: number): Promise<NotificationState | null> {
    const rows = this.notifications.filter((n) => n.contractId === contractId);
    if (rows.length === 0) return null;
    const seq = Math.max(...rows.map((n) => n.seq));
    const last = rows.filter((n) => n.seq === seq);
    return { seq, status: last[0].status, issueKeys: last.map((n) => n.issueKey) };
  }
  async claimNotification(contractId: number, seq: number, status: ContractStatus, _projected: string | null, issueKey: string) {
    if (this.notifications.some((n) => n.contractId === contractId && n.seq === seq && n.issueKey === issueKey)) return false;
    this.notifications.push({ contractId, seq, status, issueKey });
    return true;
  }
  async renegotiationBaseline() {
    return null;
  }
  async audit() {}
}

const jiraIssue = (key: string, issue: { summary: string; issueType: string; priority: string; labels: string[]; dueDate?: string }): JiraIssue => ({
  id: key,
  key,
  fields: { summary: issue.summary, labels: issue.labels, issuetype: { name: issue.issueType }, priority: { name: issue.priority }, duedate: issue.dueDate ?? null },
});

/** Runs every real seed step today and reads the Payments board, charter and history back like Accord does. */
async function seedPayments() {
  seeded.issues.clear();
  seeded.sprints.length = 0;
  seeded.sprintOf.clear();
  seeded.charters.clear();
  seeded.samples.clear();
  seeded.nextKey.clear();
  const context: SeedContext = { leadAccountId: 'lead-payments', adoptExisting: false, projectPrincipals: ['app'], today: TODAY };
  for (const step of SEED_STEPS.filter((s) => !s.startsWith('project:'))) await runSeedStep(step, context);

  const paySprints = seeded.sprints.filter((sprint) => Math.floor(sprint.id / 100) === 2);
  const sprints = paySprints.map(toPlannerSprint).filter((sprint): sprint is Sprint => sprint !== null);
  const commitments: WorkItem[] = [...seeded.sprintOf]
    .filter(([, sprintId]) => paySprints.some((sprint) => sprint.id === sprintId))
    .map(([key, sprintId]) => toWorkItem(jiraIssue(key, seeded.issues.get(key)!), String(sprintId)));
  const template = seeded.charters.get('PAY') as CharterTemplateInput;
  const charter: Charter = {
    priorities: template.priorities,
    redLines: template.redLines,
    shiftable: template.shiftable,
    maxExternalShare: template.maxExternalShare,
    responseDays: template.responseDays,
    approvers: template.approverAccountIds,
  };
  const capacity = capacityFromSamples(seeded.samples.get('team-PAY') as ThroughputSample[]);
  return { sprints, commitments, charter, capacity };
}

async function seededFlow() {
  const { sprints, commitments: initial, charter, capacity } = await seedPayments();
  let commitments = initial;
  const h = harness({ charter, capacity, sprints, commitments });
  h.deps.today = () => TODAY;
  const store = new MemoryMonitorStore();
  const deps: MonitorDeps = {
    store,
    today: () => TODAY,
    teams: {
      getTeam: async (id) => [MOB, PAY].find((team) => team.id === id) ?? null,
      capacity: async () => capacity,
      approvers: async (team) => [team.leadAccountId ?? ''],
    },
    jira: {
      commitments: async () => ({ sprints, commitments }),
      doneIssueKeys: async () => new Set(),
      addComment: async () => {},
    },
    renegotiate: async () => ({ status: 'opened', requestId: 'req-renegotiation', detail: '' }),
    cancelRenegotiations: async () => ({ cancelled: [], announced: false }),
  };
  h.deps.monitor.workAhead = (teamId, contractId) => providerWorkAhead(deps, teamId, contractId);
  /** Mirrors the Jira side of applyContract: shifted issues leave the counted sprints. */
  const applyJiraMoves = () => {
    const moved = new Map(h.jira.sprintMoves.flatMap((move) => move.keys.map((key) => [key, move.sprintId] as const)));
    const backlog = new Set(h.jira.backlogMoves.flat());
    commitments = commitments
      .filter((item) => !backlog.has(item.key))
      .map((item) => (moved.has(item.key) ? { ...item, sprintId: moved.get(item.key) } : item))
      .filter((item) => sprints.some((sprint) => sprint.id === item.sprintId));
  };
  const activeSprintId = sprints.find((sprint) => sprint.state === 'active')!.id;
  return {
    h,
    store,
    deps,
    applyJiraMoves,
    addBugs: (count: number) => {
      commitments = [
        ...commitments,
        ...CRITICAL_BUGS.slice(0, count).map((bug, i) => toWorkItem(jiraIssue(`PAY-${300 + i}`, { ...bug, labels: [DEMO_LABEL, ...bug.labels] }), activeSprintId)),
      ];
    },
    resetBugs: () => {
      // "Reset" moves the demo bugs to the backlog.
      commitments = commitments.filter((item) => !item.labels.includes('accord-demo-bug'));
    },
  };
}

describe('judge path on freshly seeded demo data (2026-11-05)', () => {
  it('seed data sanity: Payments Sprint 41 ends Nov 15, Sprint 42 ends Nov 29, 12 open issues, 9 per sprint', async () => {
    const { sprints, commitments, capacity } = await seedPayments();
    expect(sprints.map((s) => [s.name, s.state, s.endDate])).toEqual([
      ['Payments Sprint 41', 'active', '2026-11-15'],
      ['Payments Sprint 42', 'future', '2026-11-29'],
    ]);
    expect(commitments).toHaveLength(DEMO_TEAMS[1].activeIssues.length + DEMO_TEAMS[1].nextIssues.length);
    expect(commitments).toHaveLength(12);
    expect(capacity).toMatchObject({ pessimistic: 9, source: 'simulated' });
  });

  it('request S needed by Nov 26 → ≥2 options, applied contract On track, critical bugs → At risk, reset → On track', async () => {
    const flow = await seededFlow();
    const { h, store, deps } = flow;
    await h.store.insertRequest(request({ size: 'S', neededBy: addDaysIso(TODAY, 21), sourceIssueKey: 'MOB-1' }));
    await runRound1(h.deps, REQUEST_ID);
    await runRound2(h.deps, REQUEST_ID);
    const options = (await h.store.listOptions(REQUEST_ID)).filter((o) => o.kind !== 'reject');
    // PRD FR-6: 2–4 options.
    expect(options.length).toBeGreaterThanOrEqual(2);
    // 12 open issues ahead at 9 per sprint: on time only when shiftable work leaves Sprint 41/42, else Nov 29.
    expect(options.map((o) => [o.kind, o.dateRange.max, o.meetsNeed])).toEqual([
      ['on-time-with-shift', '2026-11-15', true],
      ['later', '2026-11-29', false],
    ]);

    const broker = await h.store.getRound(REQUEST_ID, 2, 'broker');
    const best = (broker?.output as { recommendedOptionId: number }).recommendedOptionId;
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
    expect((await applyContract(h.deps, REQUEST_ID)).status).toBe('done');
    const contract = await h.store.getContract(REQUEST_ID);
    const contracted = await h.store.getRequest(REQUEST_ID);
    if (!contract || !contracted) throw new Error('contract missing');
    flow.applyJiraMoves();
    store.contracts.push({ contract: { ...contract, status: 'on-track' }, request: contracted });

    // Invariant: a freshly applied contract on unchanged data is On track (projected ≤ agreed max).
    const first = await monitorProviderTeam(deps, PAY.id);
    expect(first.evaluated[0]).toMatchObject({ to: 'on-track' });
    expect(first.evaluated[0].projectedDate! <= contract.agreedDateMax).toBe(true);

    const nearest = await nearestContractProjection(deps, PAY.id);
    const needed = bugsUntilAtRisk(nearest!.input, 8);
    expect(needed).toBeGreaterThan(0);
    flow.addBugs(needed!);
    expect((await monitorProviderTeam(deps, PAY.id)).evaluated[0]).toMatchObject({ to: 'at-risk' });

    flow.resetBugs();
    expect((await monitorProviderTeam(deps, PAY.id)).evaluated[0]).toMatchObject({ to: 'on-track' });
  });

  it('critical bugs → At risk → renegotiation offers ≥2 options; the recommended one applied is On track with the bugs still in', async () => {
    const flow = await seededFlow();
    const { h, store, deps } = flow;
    await h.store.insertRequest(request({ size: 'S', neededBy: addDaysIso(TODAY, 21), sourceIssueKey: 'MOB-1' }));
    await runRound1(h.deps, REQUEST_ID);
    await runRound2(h.deps, REQUEST_ID);
    await approveRecommended(h, REQUEST_ID);
    expect((await applyContract(h.deps, REQUEST_ID)).status).toBe('done');
    const contract = (await h.store.getContract(REQUEST_ID))!;
    flow.applyJiraMoves();
    store.contracts.push({ contract: { ...contract, status: 'on-track' }, request: (await h.store.getRequest(REQUEST_ID))! });
    await monitorProviderTeam(deps, PAY.id);

    deps.renegotiate = (trigger) => openRenegotiation(h.deps, trigger, RENEGOTIATION_ID);
    flow.addBugs(bugsUntilAtRisk((await nearestContractProjection(deps, PAY.id))!.input, 8)!);
    const risky = await monitorProviderTeam(deps, PAY.id);
    expect(risky.renegotiations).toEqual([expect.objectContaining({ status: 'opened' })]);
    await runRound1(h.deps, RENEGOTIATION_ID);
    await runRound2(h.deps, RENEGOTIATION_ID);
    const options = (await h.store.listOptions(RENEGOTIATION_ID)).filter((o) => o.kind !== 'reject');
    // PRD FR-6: a real choice, also in the renegotiation.
    expect(options.length).toBeGreaterThanOrEqual(2);
    // 8 counted + 1 bug + 1 at 9 per sprint misses Nov 15; one more shiftable issue (Medium, not red line)
    // leaves the monitor's window (active + next sprint). The red-line demo bugs never move.
    expect(options.map((o) => [o.kind, o.dateRange.max, o.shifted.map((s) => s.key)])).toEqual([
      ['on-time-with-shift', '2026-11-15', ['PAY-6']],
      ['later', '2026-11-29', []],
    ]);

    await approveRecommended(h, RENEGOTIATION_ID);
    expect((await applyContract(h.deps, RENEGOTIATION_ID)).status).toBe('done');
    const renegotiated = (await h.store.getContract(RENEGOTIATION_ID))!;
    flow.applyJiraMoves();
    store.contracts[0].contract.status = 'superseded';
    store.contracts.push({ contract: { ...renegotiated, status: 'on-track' }, request: (await h.store.getRequest(RENEGOTIATION_ID))! });
    // Same invariant after the renegotiation: on the same data (bugs still in the sprint) it is On track.
    const after = await monitorProviderTeam(deps, PAY.id);
    expect(after.evaluated.find((e) => e.contractId === renegotiated.id)).toMatchObject({ to: 'on-track' });
  });
});

describe('two contracts on freshly seeded demo data', () => {
  it('a new contract agreed earlier than an open one never puts the open one at risk after apply', async () => {
    const flow = await seededFlow();
    const { h, store, deps } = flow;
    const apply = async (requestId: string) => {
      await runRound1(h.deps, requestId);
      await runRound2(h.deps, requestId);
      await approveRecommended(h, requestId);
      expect((await applyContract(h.deps, requestId)).status).toBe('done');
      flow.applyJiraMoves();
      const contract = (await h.store.getContract(requestId))!;
      store.contracts.push({ contract: { ...contract, status: 'on-track' }, request: (await h.store.getRequest(requestId))! });
      return contract;
    };
    // First an L request needed late in December, then an S request needed by Nov 26 (agreed earlier).
    await h.store.insertRequest(request({ size: 'L', neededBy: addDaysIso(TODAY, 52), sourceIssueKey: 'MOB-1', title: 'Refund API' }));
    const old = await apply(REQUEST_ID);
    await h.store.insertRequest(request({ id: SECOND_ID, size: 'S', neededBy: addDaysIso(TODAY, 21), sourceIssueKey: 'MOB-2', title: 'Refund status' }));
    const newer = await apply(SECOND_ID);
    // The L contract (Dec 13) is not ahead of a request agreed by Nov 15 in the monitor order: 12 counted + 1
    // misses Sprint 41 at 9 per sprint until shiftable work leaves Sprint 41/42; the L contract then follows.
    expect([old.agreedDateMax, newer.agreedDateMax]).toEqual(['2026-12-13', '2026-11-15']);

    const result = await monitorProviderTeam(deps, PAY.id);
    expect(result.evaluated.map((e) => [e.contractId, e.to])).toEqual([
      [newer.id, 'on-track'],
      [old.id, 'on-track'],
    ]);
  });
});

const SECOND_ID = 'req-00000000-0000-4000-8000-0000000000bb';
const RENEGOTIATION_ID = 'req-00000000-0000-4000-8000-0000000000aa';

async function approveRecommended(h: Awaited<ReturnType<typeof seededFlow>>['h'], requestId: string) {
  const broker = await h.store.getRound(requestId, 2, 'broker');
  const best = (broker?.output as { recommendedOptionId: number }).recommendedOptionId;
  await decide(h.deps, { requestId, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
  await decide(h.deps, { requestId, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
}
