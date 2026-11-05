import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ route: (strings: TemplateStringsArray) => strings.join('') }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

import { requireSeedAccess, seedAccessError, type SeedAccess, type SeedPlan } from '../../src/demo/seed';

const plan = (states: Array<SeedPlan['projects'][number]['state']>): SeedPlan => ({
  projects: states.map((state, index) => ({ slot: index ? 'PAY' : 'MOB', name: index ? 'Payments' : 'Mobile', projectKey: index ? 'ACPAY' : 'ACMOB', state })),
  space: { key: 'ACCORD', state: 'accord' },
});

const access = (siteAdmin: boolean, adminOf: string[] = []): SeedAccess => ({
  siteAdmin,
  projectAdmin: async (key) => adminOf.includes(key),
});

describe('demo seed access (NFR-3)', () => {
  it('refuses a user who is neither site admin nor admin of the target projects', async () => {
    expect(await seedAccessError(plan(['accord', 'accord']), access(false))).toMatch(/project administrator of ACMOB/);
    expect(await seedAccessError(plan(['accord', 'accord']), access(false, ['ACMOB']))).toMatch(/ACPAY/);
  });

  it('needs a site admin to create projects', async () => {
    expect(await seedAccessError(plan(['create', 'accord']), access(false, ['ACMOB', 'ACPAY']))).toMatch(/site admin can create/);
    expect(await seedAccessError(plan(['create', 'create']), access(true))).toBeNull();
  });

  it('adopting an existing project needs an admin of that project', async () => {
    expect(await seedAccessError(plan(['adopted', 'accord']), access(false, ['ACPAY']))).toMatch(/ACMOB/);
    expect(await seedAccessError(plan(['adopted', 'accord']), access(false, ['ACMOB', 'ACPAY']))).toBeNull();
  });

  it('requires a signed-in user before any Jira call', async () => {
    const check = vi.fn(async () => access(true));
    await expect(requireSeedAccess(undefined, false, check)).rejects.toThrow(/signed-in/);
    expect(check).not.toHaveBeenCalled();
  });
});
