import { UserFacingError } from '../errors';
import { run, select } from '../sql/db';
import { audit } from '../teams/repository';

/** Demo mode: one account may approve a deal sheet for both teams (dual control off). Default off. */
export const DEMO_MODE_SETTING = 'demo.allow-same-approver';

export async function getSetting(key: string): Promise<string | null> {
  const rows = await select<{ value: string }>('SELECT value FROM app_settings WHERE setting_key = ?', [key]);
  return rows[0] ? String(rows[0].value) : null;
}

export async function setSetting(key: string, value: string, updatedBy: string | null): Promise<void> {
  await run(
    `INSERT INTO app_settings (setting_key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
    [key, value, updatedBy],
  );
}

/** Storage and audit of the demo mode switch, injected so the rules can be tested without Forge. */
export interface DemoModePort {
  enabled(): Promise<boolean>;
  setEnabled(enabled: boolean, accountId: string): Promise<void>;
  audit(action: 'demo-mode-enabled' | 'demo-mode-disabled', actor: string, payload: unknown): Promise<void>;
}

export const demoModePort: DemoModePort = {
  enabled: async () => (await getSetting(DEMO_MODE_SETTING)) === 'true',
  setEnabled: (enabled, accountId) => setSetting(DEMO_MODE_SETTING, String(enabled), accountId),
  audit: (action, actor, payload) => audit('demo', 'mode', action, actor, payload),
};

/** Inputs of the same-approver rule, injected so it can be tested without Forge. */
export interface SameApproverCheck {
  enabled(): Promise<boolean>;
  /** Jira keys of the demo projects Accord created itself (never foreign projects with a similar key). */
  demoProjectKeys(): Promise<string[]>;
}

/**
 * Demo mode relaxes dual control only for requests between two of Accord's own demo projects; requests that
 * involve any other team keep dual control. Fails closed: when a check fails, dual control stays on.
 */
export async function sameApproverAllowed(
  check: SameApproverCheck,
  projects: { requester: string; provider: string },
): Promise<boolean> {
  try {
    if (!(await check.enabled())) return false;
    const demo = new Set(await check.demoProjectKeys());
    return demo.has(projects.requester) && demo.has(projects.provider);
  } catch (error) {
    console.warn('Accord demo mode check failed; dual control stays on', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Turns demo mode on or off. Same rule as "Make me the demo lead": the caller must be a Jira site admin or a
 * project administrator of every Accord demo project (`canManage`, checked as the signed-in user).
 */
export async function changeDemoMode(
  port: DemoModePort,
  input: {
    accountId: string | undefined;
    enabled: unknown;
    projects: ReadonlyArray<{ projectKey: string }>;
    canManage: (projectKey: string) => Promise<boolean>;
  },
): Promise<{ enabled: boolean; changed: boolean }> {
  const { accountId, enabled, projects, canManage } = input;
  if (!accountId) throw new UserFacingError('A signed-in Jira user is required.');
  if (typeof enabled !== 'boolean') throw new UserFacingError('Demo mode must be turned on or off.');
  if (projects.length === 0) throw new UserFacingError('There are no Accord demo projects yet. Run "Seed demo data" first.');
  for (const project of projects) {
    if (!(await canManage(project.projectKey))) {
      throw new UserFacingError(`Only a Jira site admin or a project administrator of ${project.projectKey} can change demo mode.`);
    }
  }
  if ((await port.enabled()) === enabled) return { enabled, changed: false };
  await port.setEnabled(enabled, accountId);
  await port.audit(enabled ? 'demo-mode-enabled' : 'demo-mode-disabled', accountId, {
    projects: projects.map((project) => project.projectKey),
  });
  return { enabled, changed: true };
}
