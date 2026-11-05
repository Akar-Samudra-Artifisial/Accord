import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({
  default: {},
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
}));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));
// Jira answers 404 to mypermissions for ACPAY, the project the viewer cannot browse.
vi.mock('../../src/atlassian/http', async () => {
  const actual = await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http');
  return {
    ...actual,
    jira: vi.fn(async (path: string) => {
      if (path.includes('projectKey=ACPAY')) throw new actual.AtlassianApiError('jira', 404, path, 'No project could be found');
      return { permissions: { BROWSE_PROJECTS: { havePermission: true } } };
    }),
  };
});
vi.mock('../../src/teams/repository', async () => {
  const teams = ['ACMOB', 'ACPAY', 'ACWEB'].map((key, i) => ({ id: `t-${key}`, teamKey: key, name: key, jiraProjectKey: key, boardId: i, leadAccountId: null, charterPageId: null }));
  return {
    ...(await vi.importActual<typeof import('../../src/teams/repository')>('../../src/teams/repository')),
    listTeams: vi.fn(async () => teams),
  };
});
// The viewer leads ACMOB only; ACPAY and ACWEB need the browse check.
vi.mock('../../src/negotiation/deps', () => ({
  productionDeps: {},
  teamDirectory: { approvers: vi.fn(async (team: { teamKey: string }) => (team.teamKey === 'ACMOB' ? ['lukas'] : [])) },
}));
const CREATED = { id: 1, entityType: 'request', entityId: 'req-1', action: 'created', actorAccountId: 'lukas', payload: {}, createdAt: '2026-11-06T10:00:00Z' };
const auditEntries = vi.hoisted(() => [] as unknown[]);
// The viewer can browse ACMOB and ACWEB issues, not ACPAY ones.
const visibleIssueKeys = vi.hoisted(() => vi.fn(async (keys: readonly string[], _as?: string) => new Set(keys.filter((key) => !key.startsWith('ACPAY-')))));
vi.mock('../../src/jira/issues', async () => ({
  ...(await vi.importActual<typeof import('../../src/jira/issues')>('../../src/jira/issues')),
  visibleIssueKeys,
}));
// req-1: the viewer's own team asks ACPAY. req-2/req-3: teams the viewer is not an approver of.
const requestsForTeams = vi.hoisted(() =>
  vi.fn(async () => [
    { id: 'req-1', title: 'Refund API', sourceIssueKey: 'ACMOB-1', requesterTeamId: 't-ACMOB', providerTeamId: 't-ACPAY' },
    { id: 'req-2', title: 'Ledger export', sourceIssueKey: 'ACPAY-7', requesterTeamId: 't-ACPAY', providerTeamId: 't-ACWEB' },
    { id: 'req-3', title: 'Checkout banner', sourceIssueKey: 'ACWEB-1', requesterTeamId: 't-ACWEB', providerTeamId: 't-ACPAY' },
  ]),
);
vi.mock('../../src/negotiation/store', async () => ({
  ...(await vi.importActual<typeof import('../../src/negotiation/store')>('../../src/negotiation/store')),
  requestsForTeams,
  contractsForRequests: vi.fn(async () => []),
  lastDemoClean: vi.fn(async () => null),
  auditFor: vi.fn(async () => auditEntries),
  demoModeChanges: vi.fn(async () => []),
  optionsByIds: vi.fn(async () => []),
  approvalsByRequest: vi.fn(async () => new Map()),
  renegotiationsByRequest: vi.fn(async () => new Set()),
  escalationsByRequest: vi.fn(async () => new Map()),
}));

import { auditTrail, inbox } from '../../src/resolvers/negotiation';

describe('Inbox for an approver who cannot browse the source issue', () => {
  it('keeps the request title for the approver but hides the source key', async () => {
    const items = await inbox('lukas');
    expect(items.map((item) => [item.title, item.sourceIssueKey])).toEqual([
      ['Refund API', 'ACMOB-1'],
      ['Ledger export', null],
      ['Checkout banner', 'ACWEB-1'],
    ]);
    expect(visibleIssueKeys).toHaveBeenLastCalledWith(['ACMOB-1', 'ACPAY-7', 'ACWEB-1'], 'user');
  });
});

describe('Audit tab for a user without Browse on a provider project', () => {
  beforeEach(() => {
    auditEntries.splice(0, auditEntries.length, CREATED);
  });

  it('redacts deliverable keys in summaries the viewer cannot browse and keeps browsable ones', async () => {
    visibleIssueKeys.mockClear();
    const at = '2026-11-06T11:00:00Z';
    auditEntries.push(
      { id: 2, entityType: 'contract', entityId: '9', action: 'contract-applied', actorAccountId: null, createdAt: at,
        payload: { agreed: { min: '2026-11-20', max: '2026-11-27' }, deliverableCreated: false, deliverable: 'ACPAY-33' } },
      { id: 3, entityType: 'request', entityId: 'req-1', action: 'renegotiation-opened', actorAccountId: null, createdAt: at,
        payload: { note: 'Renegotiation: contract ACPAY-33 → ACMOB-1 at risk; projected finish Dec 4, 2026' } },
      { id: 4, entityType: 'contract', entityId: '9', action: 'contract-applied', actorAccountId: null, createdAt: at,
        payload: { agreed: { min: '2026-11-20', max: '2026-11-27' }, deliverableCreated: false, deliverable: 'ACWEB-5' } },
    );
    const summaries = (await auditTrail('lukas')).map((row) => row.summary);
    expect(summaries.join('\n')).not.toMatch(/ACPAY-\d/);
    expect(summaries.filter((summary) => summary.endsWith('; linked the existing deliverable (restricted)'))).toHaveLength(1);
    expect(summaries).toContain('Renegotiation: contract for a restricted issue → ACMOB-1 at risk; projected finish Dec 4, 2026');
    expect(summaries.filter((summary) => summary.endsWith('; linked existing ACWEB-5'))).toHaveLength(1);
    const checked = visibleIssueKeys.mock.calls.at(-1);
    expect(checked?.[1]).toBe('user');
    expect([...(checked?.[0] ?? [])].sort()).toEqual(['ACMOB-1', 'ACPAY-33', 'ACWEB-5']);
  });

  it('hides the title of a request whose source issue the viewer cannot browse, unless they approve for it', async () => {
    const at = '2026-11-06T12:00:00Z';
    auditEntries.push(
      { ...CREATED, id: 5, entityId: 'req-2', actorAccountId: 'someone', createdAt: at },
      { ...CREATED, id: 6, entityId: 'req-3', actorAccountId: 'someone', createdAt: at },
    );
    const subjects = new Map((await auditTrail('lukas')).map((row) => [row.id, row.subject]));
    expect(subjects.get(1)).toBe('Refund API');
    expect(subjects.get(5)).toBe('Restricted');
    expect(subjects.get(6)).toBe('Checkout banner');
    expect([...(visibleIssueKeys.mock.calls.at(-1)?.[0] ?? [])].sort()).toEqual(['ACPAY-7', 'ACWEB-1']);
  });

  it('shows the trail of the teams the user can access instead of failing on the 404', async () => {
    const rows = await auditTrail('lukas');
    expect(rows).toEqual([expect.objectContaining({ subject: 'Refund API', action: 'Request created', actor: 'You' })]);
    // ACPAY (404) is left out, ACMOB (lead) and ACWEB (browsable) stay in.
    expect(requestsForTeams).toHaveBeenCalledWith(['t-ACMOB', 't-ACWEB'], expect.anything(), 100);
  });
});
