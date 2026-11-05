import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '../../src/teams/repository';
import type { ContractStatus, DependencyRequest } from '../../src/negotiation/types';

vi.mock('@forge/api', () => ({ default: {}, route: (strings: TemplateStringsArray) => strings.join('') }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

const TEAMS: Team[] = [
  { id: 't-mob', teamKey: 'MOB', name: 'Mobile', jiraProjectKey: 'MOB', boardId: 1, leadAccountId: 'acc-mob', charterPageId: null },
  { id: 't-pay', teamKey: 'PAY', name: 'Payments', jiraProjectKey: 'PAY', boardId: 2, leadAccountId: 'acc-pay', charterPageId: null },
  { id: 't-web', teamKey: 'WEB', name: 'Web', jiraProjectKey: 'WEB', boardId: 3, leadAccountId: 'acc-web', charterPageId: null },
];

const request = (id: string, from: string, to: string, sourceIssueKey: string): DependencyRequest => ({
  id,
  requesterTeamId: from,
  providerTeamId: to,
  sourceIssueKey,
  title: `Work ${id}`,
  size: 'S',
  minSize: null,
  neededBy: '2026-12-01',
  costClass: 'standard',
  status: 'contracted',
  createdBy: 'acc-mob',
  createdAt: '2026-11-01T00:00:00Z',
});

const row = (id: number, from: string, to: string, source: string, deliverable: string, status: ContractStatus) => ({
  contract: { id, requestId: `req-${id}`, optionId: id, deliverableIssueKey: deliverable, agreedDateMin: '2026-11-20', agreedDateMax: '2026-11-27', status, projectedDate: '2026-11-25' },
  request: request(`req-${id}`, from, to, source),
});

const ROWS = [
  row(1, 't-mob', 't-pay', 'MOB-1', 'PAY-1', 'on-track'),
  row(2, 't-mob', 't-pay', 'MOB-2', 'PAY-2', 'at-risk'),
  row(3, 't-mob', 't-pay', 'MOB-3', 'PAY-3', 'superseded'),
  // The viewer is no approver of WEB or PAY and cannot browse WEB-1 / PAY-4: hidden.
  row(4, 't-web', 't-pay', 'WEB-1', 'PAY-4', 'at-risk'),
  // Not an approver, but can browse the source issue WEB-2: shown.
  row(5, 't-web', 't-pay', 'WEB-2', 'PAY-5', 'unknown'),
];

// The viewer (MOB lead) can browse the deliverables of their own contracts (PAY-1..3) and WEB-2.
const visibleIssueKeys = vi.fn(async (keys: readonly string[]): Promise<Set<string>> => new Set(keys.filter((key) => /^(MOB-\d+|WEB-2|PAY-[123])$/.test(key))));

vi.mock('../../src/jira/issues', () => ({
  ISSUE_KEY: /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]*$/,
  getIssue: vi.fn(),
  visibleIssueKeys: (keys: readonly string[]) => visibleIssueKeys(keys),
}));
vi.mock('../../src/jira/permissions', () => ({ myPermissions: vi.fn(async () => new Set()) }));
vi.mock('../../src/teams/repository', async () => ({
  ...(await vi.importActual<typeof import('../../src/teams/repository')>('../../src/teams/repository')),
  listTeams: vi.fn(async () => TEAMS),
  getTeamByKey: vi.fn(async (key: string) => TEAMS.find((team) => team.teamKey === key) ?? null),
  getTeamByProjectKey: vi.fn(async () => null),
  getCharter: vi.fn(async () => null),
}));
vi.mock('../../src/negotiation/deps', () => ({
  productionDeps: {},
  teamDirectory: { approvers: vi.fn(async (team: Team) => (team.leadAccountId ? [team.leadAccountId] : [])) },
}));
vi.mock('../../src/negotiation/store', async () => ({
  ...(await vi.importActual<typeof import('../../src/negotiation/store')>('../../src/negotiation/store')),
  listContracts: vi.fn(async () => ROWS),
  listEdges: vi.fn(async () =>
    [...ROWS].reverse().map(({ contract, request: r }) => ({ contractId: contract.id, fromTeamId: r.requesterTeamId, toTeamId: r.providerTeamId })),
  ),
  renegotiationsByRequest: vi.fn(async () => new Map()),
  renegotiationsOfParents: vi.fn(async (ids: readonly string[]) =>
    new Map(ids.includes('req-2') ? [['req-2', [{ requestId: 'req-c2', parentRequestId: 'req-2', contractId: 2, episode: 1, status: 'failed' }]]] : []),
  ),
  escalationsByRequest: vi.fn(async (ids: readonly string[]) => new Map(ids.includes('req-c2') ? [['req-c2', ['Pat Lead']]] : [])),
  contractsForRequests: vi.fn(async () => []),
}));

import { dependencyMap } from '../../src/resolvers/negotiation';

describe('dependencyMap (FR-17)', () => {
  beforeEach(() => {
    visibleIssueKeys.mockClear();
  });

  it('shows only contracts the viewer may see, like the Contracts tab', async () => {
    const map = await dependencyMap('acc-mob');
    expect(map.edges.map((edge) => edge.contractId).sort()).toEqual([1, 2, 3, 5]);
    // Source issues and deliverables are checked for every row, also the viewer's own (as the user), in one call.
    expect(visibleIssueKeys).toHaveBeenCalledTimes(1);
    expect([...visibleIssueKeys.mock.calls[0][0]].sort()).toEqual(['MOB-1', 'MOB-2', 'MOB-3', 'PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'WEB-1', 'WEB-2']);
    expect(await dependencyMap(undefined)).toEqual({ teams: [], edges: [], summary: [] });
  });

  it('redacts per field for a viewer who can browse only one side of a contract', async () => {
    // Source WEB-2 visible, deliverable PAY-5 not.
    const sourceOnly = (await dependencyMap('acc-mob')).edges.find((edge) => edge.contractId === 5);
    expect(sourceOnly).toMatchObject({ title: 'Work req-5', sourceIssueKey: 'WEB-2', deliverableIssueKey: null, deliverableRestricted: true });
    // Deliverable PAY-5 visible, source WEB-2 not: no source key, no title.
    visibleIssueKeys.mockImplementationOnce(async (keys) => new Set(keys.filter((key) => key === 'PAY-5')));
    const deliverableOnly = (await dependencyMap('acc-mob')).edges.find((edge) => edge.contractId === 5);
    expect(deliverableOnly).toMatchObject({ title: 'Restricted', sourceIssueKey: null, deliverableIssueKey: 'PAY-5', deliverableRestricted: false });
    // Parties (approver of a side) see every field they can browse.
    expect((await dependencyMap('acc-mob')).edges.find((edge) => edge.contractId === 1)).toMatchObject({
      title: 'Work req-1',
      sourceIssueKey: 'MOB-1',
      deliverableIssueKey: 'PAY-1',
      deliverableRestricted: false,
    });
  });

  it('hides the deliverable key from a party who cannot browse the provider project', async () => {
    visibleIssueKeys.mockImplementationOnce(async (keys) => new Set(keys.filter((key) => key.startsWith('MOB-'))));
    const own = (await dependencyMap('acc-mob')).edges.find((edge) => edge.contractId === 1);
    expect(own).toMatchObject({ title: 'Work req-1', sourceIssueKey: 'MOB-1', deliverableIssueKey: null, deliverableRestricted: true });
  });

  it('hides the source key from a party who cannot browse the requester project, but keeps the title', async () => {
    visibleIssueKeys.mockImplementationOnce(async (keys) => new Set(keys.filter((key) => key.startsWith('PAY-'))));
    const own = (await dependencyMap('acc-mob')).edges.find((edge) => edge.contractId === 1);
    expect(own).toMatchObject({ title: 'Work req-1', sourceIssueKey: null, deliverableIssueKey: 'PAY-1' });
  });

  it('applies the same redaction in the Contracts list', async () => {
    const { contracts } = await import('../../src/resolvers/negotiation');
    visibleIssueKeys.mockImplementationOnce(async (keys) => new Set(keys.filter((key) => key === 'PAY-5')));
    const rows = await contracts('acc-mob');
    expect(rows.find((row) => row.contractId === 5)).toMatchObject({ title: 'Restricted', sourceIssueKey: null, deliverableIssueKey: 'PAY-5' });
    expect(rows.find((row) => row.contractId === 4)).toBeUndefined();
  });

  it('gives each team its worst active status and counts renegotiations and escalations', async () => {
    const map = await dependencyMap('acc-mob');
    const team = (key: string) => map.teams.find((node) => node.teamKey === key);
    // PAY's hidden at-risk contract 4 does not count; contract 2 does.
    // The one renegotiation of contract 2 failed: history, not open.
    expect(team('PAY')).toMatchObject({ worstStatus: 'at-risk', contracts: 3, atRisk: 1, renegotiations: 0, renegotiationHistory: 1, escalations: 1 });
    expect(team('MOB')).toMatchObject({ worstStatus: 'at-risk', contracts: 2, atRisk: 1, renegotiations: 0, renegotiationHistory: 1, escalations: 1 });
    expect(team('WEB')).toMatchObject({ worstStatus: 'unknown', contracts: 1, atRisk: 0, renegotiations: 0, renegotiationHistory: 0 });
    expect(map.teams.map((node) => node.teamKey)).toEqual(['MOB', 'PAY', 'WEB']);
  });

  it('counts only renegotiations in progress as open; the inbox waits for at-risk contracts without one (FR-14)', async () => {
    const store = await import('../../src/negotiation/store');
    const { awaitingRenegotiations } = await import('../../src/resolvers/negotiation');
    // Contract 2 is at risk and its only renegotiation failed: the monitor still has to open one.
    expect(await awaitingRenegotiations('acc-mob')).toBe(1);
    expect(await awaitingRenegotiations(undefined)).toBe(0);
    const open = async () =>
      new Map([['req-2', [{ requestId: 'req-c3', parentRequestId: 'req-2', contractId: 2, episode: 2, status: 'awaiting-approval' as const }, { requestId: 'req-c2', parentRequestId: 'req-2', contractId: 2, episode: 1, status: 'failed' as const }]]]);
    vi.mocked(store.renegotiationsOfParents).mockImplementationOnce(open);
    expect(await awaitingRenegotiations('acc-mob')).toBe(0);
    vi.mocked(store.renegotiationsOfParents).mockImplementationOnce(open);
    const edge = (await dependencyMap('acc-mob')).edges.find((row) => row.contractId === 2);
    expect(edge).toMatchObject({ renegotiations: 1, renegotiationHistory: 2 });
  });

  it('dims superseded contracts, lists them last and leaves them out of the pair counts', async () => {
    const map = await dependencyMap('acc-mob');
    expect(map.edges.at(-1)).toMatchObject({ contractId: 3, dimmed: true, requester: 'Mobile', provider: 'Payments' });
    expect(map.edges[0]).toMatchObject({ contractId: 2, status: 'at-risk', renegotiations: 0, renegotiationHistory: 1, escalations: 1 });
    expect(map.summary).toEqual(
      expect.arrayContaining([
        { from: 'Mobile', to: 'Payments', contracts: 2, atRisk: 1 },
        { from: 'Web', to: 'Payments', contracts: 1, atRisk: 0 },
      ]),
    );
  });

  it('marks a team none when all its visible contracts are superseded', async () => {
    const { buildDependencyMap } = await import('../../src/resolvers/negotiation');
    const teams = new Map(TEAMS.map((team) => [team.id, team]));
    const map = buildDependencyMap(
      [{ contractId: 3, requestId: 'req-3', title: 'Old', sourceIssueKey: 'MOB-3', deliverableIssueKey: 'PAY-3', deliverableRestricted: false, agreedDateMin: '2026-11-20', agreedDateMax: '2026-11-27', projectedDate: null, status: 'superseded', renegotiationCount: 1, openRenegotiationCount: 0, escalationCount: 0 }],
      [{ contractId: 3, fromTeamId: 't-mob', toTeamId: 't-pay' }],
      teams,
    );
    expect(map.teams.map((node) => [node.teamKey, node.worstStatus, node.contracts])).toEqual([
      ['MOB', 'none', 0],
      ['PAY', 'none', 0],
    ]);
    expect(map.summary).toEqual([]);
  });
});
