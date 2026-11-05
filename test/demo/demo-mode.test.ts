import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

import { changeDemoMode, sameApproverAllowed, type DemoModePort } from '../../src/demo/demo-mode';

describe('same approver rule', () => {
  const demo = { requester: 'ACMOB', provider: 'ACPAY' };
  const check = (enabled: boolean, keys: string[] = ['ACMOB', 'ACPAY']) => ({
    enabled: async () => enabled,
    demoProjectKeys: async () => keys,
  });

  it('allows the same approver only with demo mode on and both teams Accord demo projects', async () => {
    expect(await sameApproverAllowed(check(false), demo)).toBe(false);
    expect(await sameApproverAllowed(check(true), demo)).toBe(true);
    expect(await sameApproverAllowed(check(true), { requester: 'ACMOB', provider: 'PAY' })).toBe(false);
    expect(await sameApproverAllowed(check(true), { requester: 'MOB', provider: 'PAY' })).toBe(false);
  });

  it('fails closed when a check throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = {
      enabled: async () => true,
      demoProjectKeys: async (): Promise<string[]> => {
        throw new Error('Jira unavailable');
      },
    };
    expect(await sameApproverAllowed(failing, demo)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

const ME = '557058:bayu';
const PROJECTS = [{ projectKey: 'ACMOB' }, { projectKey: 'ACPAY' }];

class FakeSettings implements DemoModePort {
  on = false;
  audits: Array<{ action: string; actor: string }> = [];
  enabled = async () => this.on;
  setEnabled = async (enabled: boolean) => {
    this.on = enabled;
  };
  audit = async (action: 'demo-mode-enabled' | 'demo-mode-disabled', actor: string) => {
    this.audits.push({ action, actor });
  };
}

describe('demo mode switch', () => {
  let settings: FakeSettings;
  beforeEach(() => {
    settings = new FakeSettings();
  });

  it('is off by default and an admin can turn it on and off, each change audited', async () => {
    expect(await settings.enabled()).toBe(false);
    const on = await changeDemoMode(settings, { accountId: ME, enabled: true, projects: PROJECTS, canManage: async () => true });
    expect(on).toEqual({ enabled: true, changed: true });
    const again = await changeDemoMode(settings, { accountId: ME, enabled: true, projects: PROJECTS, canManage: async () => true });
    expect(again.changed).toBe(false);
    await changeDemoMode(settings, { accountId: ME, enabled: false, projects: PROJECTS, canManage: async () => true });
    expect(settings.on).toBe(false);
    expect(settings.audits).toEqual([
      { action: 'demo-mode-enabled', actor: ME },
      { action: 'demo-mode-disabled', actor: ME },
    ]);
  });

  it('refuses a caller who cannot administer every demo project, without changing or auditing', async () => {
    await expect(
      changeDemoMode(settings, { accountId: ME, enabled: true, projects: PROJECTS, canManage: async (key) => key !== 'ACPAY' }),
    ).rejects.toThrow(/project administrator of ACPAY/);
    expect(settings.on).toBe(false);
    expect(settings.audits).toEqual([]);
  });

  it('refuses anonymous callers, non-boolean values and sites without demo projects', async () => {
    const admin = async () => true;
    await expect(changeDemoMode(settings, { accountId: undefined, enabled: true, projects: PROJECTS, canManage: admin })).rejects.toThrow(
      /signed-in/,
    );
    await expect(changeDemoMode(settings, { accountId: ME, enabled: 'true', projects: PROJECTS, canManage: admin })).rejects.toThrow(
      /on or off/,
    );
    await expect(changeDemoMode(settings, { accountId: ME, enabled: true, projects: [], canManage: admin })).rejects.toThrow(/Seed demo data/);
    expect(settings.on).toBe(false);
  });
});
