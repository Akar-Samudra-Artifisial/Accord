import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Jira answers per project: 'ok' grants, 'denied' answers havePermission false, a number fails with that HTTP status. */
const fake = vi.hoisted(() => ({ projects: {} as Record<string, 'ok' | 'denied' | number> }));

vi.mock('@forge/api', () => ({
  default: {},
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
}));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));
vi.mock('../../src/atlassian/http', async () => {
  const actual = await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http');
  return {
    ...actual,
    jira: vi.fn(async (path: string) => {
      if (path === '/rest/api/3/serverInfo') return { baseUrl: 'https://example.atlassian.net' };
      const match = /^\/rest\/api\/3\/mypermissions\?projectKey=([A-Z]+)&permissions=([A-Z_,]+)$/.exec(path);
      if (!match) throw new Error(`unexpected ${path}`);
      const answer = fake.projects[match[1]] ?? 'ok';
      if (typeof answer === 'number') throw new actual.AtlassianApiError('jira', answer, path, '{"errorMessages":["No project could be found"]}');
      return { permissions: Object.fromEntries(match[2].split(',').map((key) => [key, { havePermission: answer === 'ok' }])) };
    }),
  };
});
vi.mock('../../src/teams/repository', async () => {
  const teams = ['ACMOB', 'ACPAY'].map((key, i) => ({ id: `t-${i}`, teamKey: key, name: key === 'ACMOB' ? 'Mobile' : 'Payments', jiraProjectKey: key, boardId: i, leadAccountId: null, charterPageId: null }));
  return {
    ...(await vi.importActual<typeof import('../../src/teams/repository')>('../../src/teams/repository')),
    listTeams: vi.fn(async () => teams),
    getTeamByKey: vi.fn(async (key: string) => teams.find((team) => team.teamKey === key) ?? null),
    getCharter: vi.fn(async () => null),
  };
});
vi.mock('../../src/negotiation/deps', () => ({ productionDeps: {}, teamDirectory: { approvers: vi.fn(async () => []) } }));
vi.mock('../../src/teams/service', () => ({
  teamCapacity: vi.fn(async () => ({ sourceLabel: 'velocity', limitedData: false, pessimistic: 5, realistic: 6, samples: 3 })),
  loadCommitments: vi.fn(async () => ({ sprints: [], commitments: [] })),
}));
vi.mock('../../src/resolvers/negotiation', () => ({
  contracts: vi.fn(),
  createRequestFromIssue: vi.fn(),
  previewRequestFromIssue: vi.fn(),
  dealSheet: vi.fn(),
  evaluateRequestOptions: vi.fn(),
}));

import { TEAM_ACCESS_DENIED } from '../../src/actions/access';
import { actionServices } from '../../src/actions/services';
import { myPermissions } from '../../src/jira/permissions';
import { contracts } from '../../src/resolvers/negotiation';
import { teamDirectory } from '../../src/negotiation/deps';

const USER = { accountId: 'lukas', as: 'user' as const };

describe('myPermissions', () => {
  beforeEach(() => {
    fake.projects = {};
  });

  it('reads a 404 (project the user cannot browse) as no permission, never as granted', async () => {
    fake.projects.ACPAY = 404;
    expect(await myPermissions({ projectKey: 'ACPAY' }, ['BROWSE_PROJECTS', 'ADMINISTER_PROJECTS'])).toEqual(new Set());
  });

  it('still throws every other failure (401, 5xx)', async () => {
    fake.projects.ACPAY = 500;
    await expect(myPermissions({ projectKey: 'ACPAY' }, ['BROWSE_PROJECTS'])).rejects.toThrow('HTTP 500');
    fake.projects.ACPAY = 401;
    await expect(myPermissions({ projectKey: 'ACPAY' }, ['BROWSE_PROJECTS'])).rejects.toThrow('HTTP 401');
  });

  it('keeps granted and denied answers as they are', async () => {
    fake.projects.ACPAY = 'denied';
    expect(await myPermissions({ projectKey: 'ACMOB' }, ['BROWSE_PROJECTS'])).toEqual(new Set(['BROWSE_PROJECTS']));
    expect(await myPermissions({ projectKey: 'ACPAY' }, ['BROWSE_PROJECTS'])).toEqual(new Set());
  });
});

describe('Rovo team actions (Teams, Delegate) for a user without Browse on the provider project', () => {
  beforeEach(() => {
    fake.projects = { ACPAY: 404 };
  });

  it('list-teams lists every team, like the Teams tab, and marks the one the user cannot browse as restricted', async () => {
    expect(await actionServices.teams(USER)).toEqual([
      { teamKey: 'ACMOB', name: 'Mobile', jiraProjectKey: 'ACMOB', access: 'full' },
      { teamKey: 'ACPAY', name: 'Payments', jiraProjectKey: 'ACPAY', access: 'restricted' },
    ]);
  });

  it('a restricted team shares only its name and aggregate capacity (as the Teams tab), the browsable team everything', async () => {
    const restricted = await actionServices.teamCapacity('ACPAY', USER);
    expect(restricted).toEqual({
      teamKey: 'ACPAY',
      team: 'Payments',
      access: 'restricted',
      note: expect.stringMatching(/^Payments exists, but you do not have access to its Jira project/),
      source: 'velocity',
      limitedData: false,
      pessimisticPerSprint: 5,
      realisticPerSprint: 6,
      samples: 3,
    });
    const charter = await actionServices.teamCharter('ACPAY', USER);
    expect(charter).toMatchObject({ teamKey: 'ACPAY', access: 'restricted', charterStatus: 'none' });
    expect(charter).not.toHaveProperty('priorities');
    expect(charter).not.toHaveProperty('redLines');
    const full = await actionServices.teamCapacity('ACMOB', USER);
    expect(full).toMatchObject({ teamKey: 'ACMOB', access: 'full', pessimisticPerSprint: 5, sprints: [] });
    expect(await actionServices.teamCharter('ACMOB', USER)).toMatchObject({ access: 'full', priorities: [] });
  });

  it('a failing permission check counts as restricted (fail closed)', async () => {
    fake.projects = { ACPAY: 500 };
    expect((await actionServices.teams(USER)).map((team) => team.access)).toEqual(['full', 'restricted']);
    expect(await actionServices.teamCapacity('ACPAY', USER)).not.toHaveProperty('sprints');
    expect(TEAM_ACCESS_DENIED).toBe('You do not have access to this team.');
  });

  it('list-contracts states the direction from the viewer side: Mobile is owed what Payments delivers', async () => {
    const ROW = {
        contractId: 1,
        requestId: 'req-1',
        role: null,
        title: 'Refund API',
        requester: 'Mobile',
        requesterTeamKey: 'ACMOB',
        provider: 'Payments',
        providerTeamKey: 'ACPAY',
        sourceIssueKey: 'ACMOB-1',
        deliverableIssueKey: null,
        deliverableRestricted: true,
        agreedDateMin: '2026-11-20',
        agreedDateMax: '2026-11-27',
        projectedDate: '2026-11-25',
        status: 'on-track',
        renegotiation: false,
        latestRenegotiation: null,
        supersededBy: null,
    };
    vi.mocked(contracts).mockResolvedValueOnce([ROW] as never);
    const result = (await actionServices.contracts(undefined, USER)) as { contracts: Record<string, unknown>[] };
    expect(result.contracts[0]).toMatchObject({
      role: null,
      viewerRole: 'requester',
      direction: 'owed-to-you',
      counterpartTeam: 'Payments',
      directionDisplay: 'Payments owes this to your team Mobile',
      requester: 'Mobile',
      provider: 'Payments',
    });

    // A lead of both teams (approver of each) gets "both", also when asking about one team.
    vi.mocked(teamDirectory.approvers).mockResolvedValue(['lukas']);
    try {
      for (const teamKey of [undefined, 'ACPAY', 'ACMOB']) {
        vi.mocked(contracts).mockResolvedValueOnce([ROW] as never);
        const both = (await actionServices.contracts(teamKey, USER)) as { contracts: Record<string, unknown>[] };
        expect(both.contracts[0]).toMatchObject({ viewerRole: 'both', direction: 'both', directionDisplay: 'Payments delivers to Mobile' });
      }
    } finally {
      vi.mocked(teamDirectory.approvers).mockResolvedValue([]);
    }
  });
});
