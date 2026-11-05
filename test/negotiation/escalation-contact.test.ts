import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  charter: null as null | { charter: { approvers: string[]; escalationContact?: string } | null },
  browse: true as boolean | 'error',
  checks: [] as Array<{ accountId: string; projectId: string; permissions: readonly string[] }>,
  projects: [] as string[],
}));

vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []), parseJson: vi.fn() }));
vi.mock('../../src/jira/issues', () => ({
  ISSUE_KEY: /^[A-Z][A-Z0-9_]+-\d+$/,
  addComment: vi.fn(),
  createIssue: vi.fn(),
  isBlocksFrom: vi.fn(),
  listIssueLinks: vi.fn(),
  linkBlocks: vi.fn(),
  searchIssues: vi.fn(),
  updateDueDate: vi.fn(),
  userDisplayName: vi.fn(),
}));
vi.mock('../../src/jira/sprints', () => ({ moveIssuesToBacklog: vi.fn(), moveIssuesToSprint: vi.fn() }));
vi.mock('../../src/jira/permissions', () => ({
  myPermissions: vi.fn(),
  accountProjectPermissions: vi.fn(async (accountId: string, projectId: string, permissions: readonly string[]) => {
    fake.checks.push({ accountId, projectId, permissions });
    if (fake.browse === 'error') throw new Error('Jira 500');
    return new Set(fake.browse ? ['BROWSE_PROJECTS'] : []);
  }),
}));
vi.mock('../../src/teams/service', () => ({
  loadCommitments: vi.fn(),
  teamCapacity: vi.fn(),
  getProject: vi.fn(async (key: string) => {
    fake.projects.push(key);
    return { id: '10042', key };
  }),
}));
vi.mock('../../src/teams/repository', () => ({
  getCharter: vi.fn(async () => fake.charter),
  getTeamById: vi.fn(),
  audit: vi.fn(),
}));

import { teamDirectory } from '../../src/negotiation/deps';
import { PAY } from './fakes';

describe('teamDirectory.escalationContact (FR-15)', () => {
  beforeEach(() => {
    fake.charter = null;
    fake.browse = true;
    fake.checks = [];
    fake.projects = [];
  });

  it('uses the charter escalation contact when they can browse the source project', async () => {
    fake.charter = { charter: { approvers: ['a'], escalationContact: 'escalate-payments' } };
    expect(await teamDirectory.escalationContact(PAY, 'MOB_APP-7')).toEqual({ accountId: 'escalate-payments', source: 'charter' });
    expect(fake.projects).toEqual(['MOB_APP']);
    expect(fake.checks).toEqual([{ accountId: 'escalate-payments', projectId: '10042', permissions: ['BROWSE_PROJECTS'] }]);
  });

  it('falls back to the project lead with a note when the contact cannot browse the source project', async () => {
    fake.charter = { charter: { approvers: ['a'], escalationContact: 'escalate-payments' } };
    fake.browse = false;
    expect(await teamDirectory.escalationContact(PAY, 'MOB-7')).toEqual({
      accountId: 'lead-payments-project',
      source: 'project-lead',
      note: 'charter contact cannot browse MOB',
    });
  });

  it('falls back to the project lead with a note when the check fails', async () => {
    fake.charter = { charter: { approvers: ['a'], escalationContact: 'escalate-payments' } };
    fake.browse = 'error';
    expect(await teamDirectory.escalationContact(PAY, 'MOB-7')).toEqual({
      accountId: 'lead-payments-project',
      source: 'project-lead',
      note: 'charter contact browse check on MOB failed',
    });
  });

  it('falls back to the Jira project lead without a contact, without a permission check', async () => {
    fake.charter = { charter: { approvers: ['a'] } };
    expect(await teamDirectory.escalationContact(PAY, 'MOB-7')).toEqual({ accountId: 'lead-payments-project', source: 'project-lead' });
    fake.charter = null;
    expect(await teamDirectory.escalationContact(PAY, 'MOB-7')).toEqual({ accountId: 'lead-payments-project', source: 'project-lead' });
    expect(fake.checks).toEqual([]);
  });

  it('returns null without contact and lead', async () => {
    expect(await teamDirectory.escalationContact({ ...PAY, leadAccountId: null }, 'MOB-7')).toBeNull();
    fake.charter = { charter: { approvers: ['a'], escalationContact: 'escalate-payments' } };
    fake.browse = false;
    expect(await teamDirectory.escalationContact({ ...PAY, leadAccountId: null }, 'MOB-7')).toBeNull();
  });
});
