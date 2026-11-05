import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  storage: '',
  stored: null as null | { charter: { approvers: string[] } | null },
  audits: [] as Array<{ action: string; payload: unknown }>,
  checks: [] as Array<{ ignored: readonly string[]; changed: boolean }>,
}));

vi.mock('@forge/api', () => ({
  default: {},
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
}));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []), parseJson: vi.fn() }));
vi.mock('../../src/confluence/pages', () => ({
  getPage: vi.fn(async (id: string) => ({ id, title: 'Charter', version: { number: 3 }, body: { storage: { value: fake.storage } } })),
}));
vi.mock('../../src/teams/repository', () => ({
  getCharter: vi.fn(async () => fake.stored),
  saveCharter: vi.fn(async (_teamId: string, _pageId: string, _version: number, validation: { charter: { approvers: string[] } | null }) => {
    fake.stored = { charter: validation.charter };
  }),
  saveApproverCheck: vi.fn(async (_teamId: string, ignored: readonly string[], changed: boolean) => {
    fake.checks.push({ ignored, changed });
  }),
  audit: vi.fn(async (_type: string, _id: string, action: string, _actor: string | null, payload: unknown) => {
    fake.audits.push({ action, payload });
  }),
}));

import { buildCharterStorage } from '../../src/confluence/charter';
import { defaultCharterTemplate, partitionApprovers, syncCharter } from '../../src/teams/service';
import type { Team } from '../../src/teams/repository';

const team: Team = {
  id: 't1',
  teamKey: 'ACPAY',
  name: 'Payments',
  jiraProjectKey: 'ACPAY',
  boardId: 1,
  leadAccountId: 'lead',
  charterPageId: 'p1',
} as Team;

const charterWith = (approvers: string[]) =>
  buildCharterStorage({ ...defaultCharterTemplate(team, null), approverAccountIds: approvers });

describe('charter approvers need Jira permissions (NFR-3)', () => {
  beforeEach(() => {
    fake.stored = null;
    fake.audits = [];
    fake.checks = [];
  });

  it('drops approvers without the permissions and fails closed when the check errors', async () => {
    const check = async (id: string) => {
      if (id === 'broken') throw new Error('HTTP 500');
      return id === 'allowed';
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await partitionApprovers(['allowed', 'stranger', 'broken'], check)).toEqual({
      kept: ['allowed'],
      ignored: ['stranger', 'broken'],
    });
  });

  it('stores only permitted approvers and audits the ignored ones', async () => {
    fake.storage = charterWith(['lead', 'intruder']);
    const result = await syncCharter(team, async (id) => id === 'lead');
    expect(result?.charter?.approvers).toEqual(['lead']);
    expect(fake.checks).toEqual([{ ignored: ['intruder'], changed: false }]);
    expect(fake.audits.map((entry) => entry.action)).toEqual(['charter-approvers-ignored']);
  });

  it('audits a change of the effective approver list', async () => {
    fake.stored = { charter: { approvers: ['lead'] } };
    fake.storage = charterWith(['lead', 'deputy']);
    await syncCharter(team, async () => true);
    expect(fake.checks.at(-1)).toEqual({ ignored: [], changed: true });
    expect(fake.audits).toEqual([
      { action: 'charter-approvers-changed', payload: { pageVersion: 3, before: ['lead'], after: ['lead', 'deputy'] } },
    ]);
  });

  it('does not report a change when only an ignored approver was added', async () => {
    fake.stored = { charter: { approvers: ['lead'] } };
    fake.storage = charterWith(['lead', 'intruder']);
    await syncCharter(team, async (id) => id === 'lead');
    expect(fake.checks.at(-1)).toEqual({ ignored: ['intruder'], changed: false });
    expect(fake.audits.map((entry) => entry.action)).toEqual(['charter-approvers-ignored']);
  });
});
