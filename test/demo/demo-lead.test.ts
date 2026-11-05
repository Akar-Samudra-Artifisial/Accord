import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ route: (strings: TemplateStringsArray) => strings.join('') }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

import { buildCharterStorage, replaceApprovers, validateCharterStorage } from '../../src/confluence/charter';
import { assignDemoLead, type DemoLeadPort } from '../../src/demo/demo-lead';
import type { Team } from '../../src/teams/repository';

const ME = '557058:bayu';

/** In-memory demo site: ACMOB/ACPAY are Accord's; foreign MOB/PAY are never listed by the port. */
class FakeSite implements DemoLeadPort {
  leads = new Map([
    ['ACMOB', 'alana'],
    ['ACPAY', 'alana'],
    ['PAY', 'someone-else'],
  ]);
  approvers = new Map([
    ['page-ACMOB', ['alana']],
    ['page-ACPAY', ['alana']],
  ]);
  writes: string[] = [];
  accordProjects = async () => [
    { projectKey: 'ACMOB', name: 'Mobile' },
    { projectKey: 'ACPAY', name: 'Payments' },
  ];
  projectLead = async (key: string) => this.leads.get(key) ?? null;
  setProjectLead = async (key: string, accountId: string) => {
    this.writes.push(`lead:${key}`);
    this.leads.set(key, accountId);
  };
  refreshTeam = async (key: string) => ({ teamKey: key, charterPageId: `page-${key}` }) as unknown as Team;
  charterApprovers = async (pageId: string) => this.approvers.get(pageId) ?? [];
  setCharterApprovers = async (pageId: string, ids: readonly string[]) => {
    this.writes.push(`approvers:${pageId}`);
    this.approvers.set(pageId, [...ids]);
  };
  syncCharter = async () => true;
}

describe('Make me the demo lead', () => {
  let site: FakeSite;
  beforeEach(() => {
    site = new FakeSite();
  });

  it('makes the caller lead and only approver of the Accord demo projects, idempotently', async () => {
    const first = await assignDemoLead(ME, async () => true, site);
    expect(first.map((r) => [r.projectKey, r.leadChanged, r.approversChanged, r.charterValid])).toEqual([
      ['ACMOB', true, true, true],
      ['ACPAY', true, true, true],
    ]);
    expect(site.leads.get('PAY')).toBe('someone-else');
    expect(site.approvers.get('page-ACPAY')).toEqual([ME]);

    site.writes = [];
    const second = await assignDemoLead(ME, async () => true, site);
    expect(second.every((r) => !r.leadChanged && !r.approversChanged)).toBe(true);
    expect(site.writes).toEqual([]);
  });

  it('refuses a caller who cannot administer every demo project, before writing anything', async () => {
    await expect(assignDemoLead(ME, async (key) => key !== 'ACPAY', site)).rejects.toThrow(/project administrator of ACPAY/);
    expect(site.writes).toEqual([]);
  });

  it('rejects an invalid account id', async () => {
    await expect(assignDemoLead('x" onload', async () => true, site)).rejects.toThrow(/account id/);
  });
});

describe('replaceApprovers', () => {
  const storage = buildCharterStorage({
    teamName: 'Payments',
    priorities: ['Ledger migration'],
    redLines: [{ field: 'label', value: 'security' }],
    shiftable: [{ field: 'priority', value: 'Low' }],
    maxExternalShare: 0.25,
    responseDays: 2,
    approverAccountIds: ['alana'],
    escalationAccountId: 'manager',
  });

  it('changes only the Approvers section and keeps the charter valid', () => {
    const next = replaceApprovers(storage, [ME]);
    expect(next).not.toBeNull();
    const before = validateCharterStorage(storage).charter;
    const after = validateCharterStorage(next as string);
    expect(after.valid).toBe(true);
    expect(after.charter).toEqual({ ...before, approvers: [ME] });
    expect(replaceApprovers(next as string, [ME])).toBe(next);
  });

  it('returns null without an Approvers heading', () => {
    expect(replaceApprovers('<h2>Priorities</h2><ul><li>x</li></ul>', [ME])).toBeNull();
  });
});
