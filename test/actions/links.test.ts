import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ serverInfoCalls: 0, baseUrl: 'https://one-atlas-vyyd.atlassian.net' as unknown, permissionChecks: [] as string[] }));

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
    jira: vi.fn(async (path: string, options?: { as?: string }) => {
      if (path === '/rest/api/3/serverInfo') {
        fake.serverInfoCalls += 1;
        return { baseUrl: fake.baseUrl };
      }
      const browse = /^\/rest\/api\/3\/mypermissions\?projectKey=([A-Z]+)&permissions=BROWSE_PROJECTS$/.exec(path);
      if (browse) {
        fake.permissionChecks.push(`${browse[1]} as ${options?.as}`);
        return { permissions: { BROWSE_PROJECTS: { havePermission: browse[1] !== 'ACSEC' } } };
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
});
vi.mock('../../src/teams/repository', async () => ({
  ...(await vi.importActual<typeof import('../../src/teams/repository')>('../../src/teams/repository')),
  listTeams: vi.fn(async () =>
    ['ACMOB', 'ACPAY', 'ACSEC'].map((key, i) => ({ id: `t-${i}`, teamKey: key, name: key, jiraProjectKey: key, boardId: i, leadAccountId: null, charterPageId: null })),
  ),
}));
vi.mock('../../src/resolvers/negotiation', () => ({
  contracts: vi.fn(async () => [
    { contractId: 1, requestId: 'req-1', title: 'Refund API', sourceIssueKey: 'ACMOB-1', deliverableIssueKey: 'ACPAY-13', status: 'on-track' },
    { contractId: 2, requestId: 'req-2', title: 'Pending', sourceIssueKey: 'ACMOB-2', deliverableIssueKey: null, status: 'unknown' },
    // Redacted: the viewer can browse neither issue key returned here.
    { contractId: 3, requestId: 'req-4', title: 'Restricted', sourceIssueKey: null, deliverableIssueKey: null, deliverableRestricted: true, status: 'on-track' },
  ]),
  createRequestFromIssue: vi.fn(async () => ({ requestId: 'req-3', status: 'negotiating' })),
  previewRequestFromIssue: vi.fn(async () => ({
    sourceIssueKey: 'ACMOB-1',
    requesterTeam: { teamKey: 'ACMOB', name: 'Mobile' },
    providerTeam: { teamKey: 'ACPAY', name: 'Payments' },
    title: 'Refund API',
    size: 'S',
    minSize: null,
    neededBy: '2026-11-20',
    costClass: 'standard',
  })),
  dealSheet: vi.fn(),
  evaluateRequestOptions: vi.fn(),
}));

import { contractLinks, parseBaseUrl, requestLinks, siteLinks } from '../../src/actions/links';
import { actionServices } from '../../src/actions/services';

const USER = { accountId: 'user-1', as: 'user' as const };
const SITE = 'https://one-atlas-vyyd.atlassian.net';

describe('site links', () => {
  it('builds absolute issue and page links from the site base URL', () => {
    const links = siteLinks(`${SITE}/`);
    expect(links.issue('ACPAY-13')).toBe(`${SITE}/browse/ACPAY-13`);
    expect(links.page('7110657')).toBe(`${SITE}/wiki/pages/viewpage.action?pageId=7110657`);
    expect(contractLinks(links, { sourceIssueKey: 'ACMOB-1', deliverableIssueKey: null })).toEqual({
      url: `${SITE}/browse/ACMOB-1`,
      sourceIssueUrl: `${SITE}/browse/ACMOB-1`,
      deliverableIssueUrl: null,
    });
    expect(requestLinks(links, 'ACMOB-1').url).toBe(`${SITE}/browse/ACMOB-1`);
    // A source issue the viewer cannot browse has no link.
    expect(requestLinks(links, null)).toEqual({ url: null, sourceIssueUrl: null });
  });

  it('refuses a base URL that is not absolute https', () => {
    expect(() => parseBaseUrl('http://example.test')).toThrow(/https/);
    expect(() => parseBaseUrl('/relative')).toThrow();
    expect(() => parseBaseUrl(undefined)).toThrow(/baseUrl/);
  });
});

describe('action outputs carry real URLs', () => {
  beforeEach(() => {
    fake.baseUrl = SITE;
  });

  it('list-contracts links each contract to its deliverable and source issue', async () => {
    const result = (await actionServices.contracts(undefined, USER)) as { contracts: Array<Record<string, unknown>> };
    expect(result.contracts[0]).toMatchObject({
      url: `${SITE}/browse/ACPAY-13`,
      sourceIssueUrl: `${SITE}/browse/ACMOB-1`,
      deliverableIssueUrl: `${SITE}/browse/ACPAY-13`,
    });
    expect(result.contracts[1]).toMatchObject({ url: `${SITE}/browse/ACMOB-2`, deliverableIssueUrl: null });
    // Redacted keys get no links.
    expect(result.contracts[2]).toMatchObject({ title: 'Restricted', url: null, sourceIssueUrl: null, deliverableIssueUrl: null });
  });

  it('list-teams returns every team, restricted where the user cannot browse the project (checked as the user)', async () => {
    fake.permissionChecks.length = 0;
    expect((await actionServices.teams(USER)).map((team) => [team.teamKey, team.access])).toEqual([
      ['ACMOB', 'full'],
      ['ACPAY', 'full'],
      ['ACSEC', 'restricted'],
    ]);
    expect(fake.permissionChecks.sort()).toEqual(['ACMOB as user', 'ACPAY as user', 'ACSEC as user']);
    await expect(actionServices.teams({ accountId: undefined, as: 'user' })).rejects.toThrow(/signed-in/);
  });

  it('the create preview shows teams, title and dates and creates nothing', async () => {
    const { createRequestFromIssue } = await import('../../src/resolvers/negotiation');
    const before = vi.mocked(createRequestFromIssue).mock.calls.length;
    const result = await actionServices.previewRequest(
      { sourceIssueKey: 'ACMOB-1', providerTeamKey: 'ACPAY', title: '', size: 'S', minSize: null, neededBy: '2026-11-20', costClass: 'standard' },
      USER,
    );
    expect(result).toMatchObject({
      preview: true,
      created: false,
      requesterTeam: { teamKey: 'ACMOB' },
      providerTeam: { teamKey: 'ACPAY' },
      title: 'Refund API',
      neededByDisplay: expect.any(String),
    });
    expect(vi.mocked(createRequestFromIssue).mock.calls.length).toBe(before);
  });

  it('create-dependency-request links the deal sheet on the source issue and caches the base URL', async () => {
    const result = await actionServices.createRequest(
      { sourceIssueKey: 'ACMOB-1', providerTeamKey: 'ACPAY', title: 'Refund API', size: 'S', minSize: null, neededBy: '2026-11-20', costClass: 'standard' },
      USER,
    );
    expect(result).toMatchObject({ requestId: 'req-3', sourceIssueKey: 'ACMOB-1', url: `${SITE}/browse/ACMOB-1` });
    expect(fake.serverInfoCalls).toBe(1);
  });
});
