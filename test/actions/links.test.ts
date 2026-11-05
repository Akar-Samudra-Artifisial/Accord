import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ serverInfoCalls: 0, baseUrl: 'https://one-atlas-vyyd.atlassian.net' as unknown }));

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
      if (path === '/rest/api/3/serverInfo') {
        fake.serverInfoCalls += 1;
        return { baseUrl: fake.baseUrl };
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
});
vi.mock('../../src/resolvers/negotiation', () => ({
  contracts: vi.fn(async () => [
    { contractId: 1, requestId: 'req-1', title: 'Refund API', sourceIssueKey: 'ACMOB-1', deliverableIssueKey: 'ACPAY-13', status: 'on-track' },
    { contractId: 2, requestId: 'req-2', title: 'Pending', sourceIssueKey: 'ACMOB-2', deliverableIssueKey: null, status: 'unknown' },
  ]),
  createRequestFromIssue: vi.fn(async () => ({ requestId: 'req-3', status: 'negotiating' })),
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
