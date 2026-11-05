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

  it('list-teams answers without the team the user cannot browse instead of failing', async () => {
    expect(await actionServices.teams(USER)).toEqual([{ teamKey: 'ACMOB', name: 'Mobile', jiraProjectKey: 'ACMOB' }]);
  });

  it('team capacity and charter answer with the generic access message, the browsable team still works', async () => {
    await expect(actionServices.teamCapacity('ACPAY', USER)).rejects.toThrow(TEAM_ACCESS_DENIED);
    await expect(actionServices.teamCharter('ACPAY', USER)).rejects.toThrow(TEAM_ACCESS_DENIED);
    expect(await actionServices.teamCapacity('ACMOB', USER)).toMatchObject({ teamKey: 'ACMOB', pessimisticPerSprint: 5 });
  });
});
