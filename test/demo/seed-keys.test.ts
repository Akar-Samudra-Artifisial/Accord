import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  /** Existing Jira projects: key → has the accord.demo property. */
  projects: new Map<string, boolean>(),
  /** Rows in this installation's teams table: key → team name. */
  teams: new Map<string, string>(),
}));

vi.mock('@forge/api', () => ({
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
      const match = /^\/rest\/api\/3\/project\/([A-Z0-9]+)\/properties\/accord\.demo$/.exec(path);
      if (match && fake.projects.get(match[1])) return { key: 'accord.demo', value: { createdBy: 'accord' } };
      throw new actual.AtlassianApiError('jira', 404, path, 'not found');
    }),
  };
});
vi.mock('../../src/teams/repository', () => ({
  getTeamByKey: vi.fn(async (key: string) =>
    fake.teams.has(key) ? { id: `team-${key}`, teamKey: key, name: fake.teams.get(key), jiraProjectKey: key } : null,
  ),
  saveThroughput: vi.fn(),
}));
vi.mock('../../src/teams/service', async () => {
  const { AtlassianApiError } = await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http');
  return {
    getProject: vi.fn(async (key: string) => {
      if (!fake.projects.has(key)) throw new AtlassianApiError('jira', 404, `/project/${key}`, 'not found');
      return { key, name: key };
    }),
    registerTeam: vi.fn(),
    createCharterPage: vi.fn(),
    resolveCharterSpace: vi.fn(async () => ({ key: 'ACCORD', state: 'accord', space: null })),
    TeamSetupError: class extends Error {},
  };
});

import { resolveDemoProject } from '../../src/demo/seed';
import { demoTeam, keyCandidates, pickKey, projectKeyCandidates } from '../../src/demo/seed-data';

const mobile = demoTeam('MOB');
const payments = demoTeam('PAY');

describe('demo key candidates', () => {
  it('prefers the slot key, then AC<slot>, AC<slot>2 … within Jira key rules', () => {
    const keys = projectKeyCandidates('MOB');
    expect(keys.slice(0, 3)).toEqual(['MOB', 'ACMOB', 'ACMOB2']);
    expect(keys.every((key) => /^[A-Z][A-Z0-9]{1,9}$/.test(key))).toBe(true);
    expect(keyCandidates('ACCORD', 'ACCORD').slice(0, 3)).toEqual(['ACCORD', 'ACCORD2', 'ACCORD3']);
  });

  it('pickKey skips foreign keys and fails when every candidate is taken', async () => {
    const taken = new Set(['ACCORD', 'ACCORD2']);
    await expect(pickKey(keyCandidates('ACCORD', 'ACCORD'), async (k) => (taken.has(k) ? 'foreign' : 'missing'))).resolves.toEqual({
      key: 'ACCORD3',
      state: 'missing',
    });
    await expect(pickKey(['A1', 'A2'], async () => 'foreign')).rejects.toThrow(/A1, A2/);
  });
});

describe('resolveDemoProject', () => {
  beforeEach(() => {
    fake.projects.clear();
    fake.teams.clear();
  });

  it('creates the slot key on an empty site', async () => {
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'MOB', state: 'create', name: 'Mobile' });
  });

  it('never touches a foreign MOB/PAY: picks ACMOB/ACPAY instead', async () => {
    fake.projects.set('MOB', false);
    fake.projects.set('PAY', false);
    fake.teams.set('PAY', 'Arkana Payments');
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'ACMOB', state: 'create' });
    expect(await resolveDemoProject(payments, false)).toMatchObject({ projectKey: 'ACPAY', state: 'create' });
  });

  it('moves on to ACMOB2 when ACMOB is foreign too, and keeps re-resolving to the Accord project', async () => {
    fake.projects.set('MOB', false);
    fake.projects.set('ACMOB', false);
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'ACMOB2', state: 'create' });
    fake.projects.set('ACMOB2', true);
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'ACMOB2', state: 'accord' });
  });

  it('recognises an Accord MOB by its project property', async () => {
    fake.projects.set('MOB', true);
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'MOB', state: 'accord' });
  });

  it('recognises a legacy Accord project without property through the teams table and demo name', async () => {
    fake.projects.set('MOB', false);
    fake.projects.set('PAY', false);
    fake.teams.set('MOB', 'Mobile');
    fake.teams.set('PAY', 'Payments');
    expect(await resolveDemoProject(mobile, false)).toMatchObject({ projectKey: 'MOB', state: 'accord' });
    expect(await resolveDemoProject(payments, false)).toMatchObject({ projectKey: 'PAY', state: 'accord' });
  });

  it('adopts a foreign slot project only when asked to', async () => {
    fake.projects.set('PAY', false);
    expect(await resolveDemoProject(payments, true)).toMatchObject({ projectKey: 'PAY', state: 'adopted' });
  });
});
