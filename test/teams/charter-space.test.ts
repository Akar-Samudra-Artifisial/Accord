import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  spaces: new Map<string, { id: string; key: string; name: string; type: string }>(),
  pages: new Map<string, string>(),
  teams: [] as Array<{ charterPageId: string | null }>,
  created: [] as string[],
}));

vi.mock('@forge/api', () => ({
  default: {},
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
}));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []), parseJson: vi.fn() }));
vi.mock('../../src/confluence/pages', async () => {
  const { AtlassianApiError } = await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http');
  return {
    getSpaceByKey: vi.fn(async (key: string) => fake.spaces.get(key) ?? null),
    getPage: vi.fn(async (id: string) => {
      const spaceId = fake.pages.get(id);
      if (!spaceId) throw new AtlassianApiError('confluence', 404, `/pages/${id}`, 'not found');
      return { id, title: 't', spaceId };
    }),
    createSpace: vi.fn(async (key: string, name: string) => {
      fake.created.push(key);
      return { id: `s-${key}`, key, name, type: 'global' };
    }),
    listSpaces: vi.fn(async () => []),
    addCharterLabel: vi.fn(),
    createPage: vi.fn(),
    findPageByTitle: vi.fn(),
  };
});
vi.mock('../../src/teams/repository', async () => {
  const actual = await vi.importActual<typeof import('../../src/teams/repository')>('../../src/teams/repository');
  return { ...actual, listTeams: vi.fn(async () => fake.teams) };
});

import { ensureCharterSpace, resolveCharterSpace } from '../../src/teams/service';

const space = (id: string, key: string, name: string) => ({ id, key, name, type: 'global' });

describe('charter space key', () => {
  beforeEach(() => {
    fake.spaces.clear();
    fake.pages.clear();
    fake.teams = [];
    fake.created = [];
  });

  it('creates ACCORD on a site without it', async () => {
    expect(await resolveCharterSpace()).toMatchObject({ key: 'ACCORD', state: 'missing' });
    expect((await ensureCharterSpace()).key).toBe('ACCORD');
    expect(fake.created).toEqual(['ACCORD']);
  });

  it('uses ACCORD2 when ACCORD belongs to someone else', async () => {
    fake.spaces.set('ACCORD', space('1', 'ACCORD', 'Accord Legal'));
    expect((await ensureCharterSpace()).key).toBe('ACCORD2');
    expect(fake.created).toEqual(['ACCORD2']);
  });

  it('keeps an Accord ACCORD space, recognised by name or by a registered charter page', async () => {
    fake.spaces.set('ACCORD', space('1', 'ACCORD', 'Accord team charters'));
    expect(await resolveCharterSpace()).toMatchObject({ key: 'ACCORD', state: 'accord' });

    fake.spaces.set('ACCORD', space('1', 'ACCORD', 'Renamed charters'));
    fake.pages.set('p1', '1');
    fake.teams = [{ charterPageId: 'p1' }, { charterPageId: null }];
    expect(await resolveCharterSpace()).toMatchObject({ key: 'ACCORD', state: 'accord' });
    expect(fake.created).toEqual([]);
  });
});
