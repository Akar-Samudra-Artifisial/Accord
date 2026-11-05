import { route } from '@forge/api';
import { AtlassianApiError, jira } from '../atlassian/http';
import { replaceApprovers, validateCharterStorage } from '../confluence/charter';
import { getPage, updatePage } from '../confluence/pages';
import { UserFacingError } from '../errors';
import { myPermissions } from '../jira/permissions';
import { getTeamByKey, type Team } from '../teams/repository';
import { getProject, registerTeam, syncCharter } from '../teams/service';
import { DEMO_TEAMS } from './seed-data';
import { resolveDemoProject } from './seed';

export const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export interface DemoLeadResult {
  projectKey: string;
  team: string;
  leadChanged: boolean;
  approversChanged: boolean;
  charterValid: boolean | null;
}

/** Side effects of "Make me the demo lead", injected so the flow can be tested without Forge. */
export interface DemoLeadPort {
  /** Demo projects created by Accord (never foreign projects with the same key). */
  accordProjects(): Promise<Array<{ projectKey: string; name: string }>>;
  projectLead(projectKey: string): Promise<string | null>;
  setProjectLead(projectKey: string, accountId: string): Promise<void>;
  /** Re-registers the team so `teams.lead_account_id` follows the new project lead. */
  refreshTeam(projectKey: string): Promise<Team>;
  /** Charter approvers on the page, then the page rewritten with only the Approvers section changed. */
  charterApprovers(pageId: string): Promise<string[]>;
  setCharterApprovers(pageId: string, accountIds: readonly string[]): Promise<void>;
  syncCharter(team: Team): Promise<boolean | null>;
}

/**
 * Makes `accountId` the lead of every Accord demo project and the only approver of its charter.
 * Idempotent: nothing is written when the lead and approvers already match. This only assigns demo
 * data ownership; no call is made on behalf of that account.
 */
export async function assignDemoLead(
  accountId: string,
  canManage: (projectKey: string) => Promise<boolean>,
  port: DemoLeadPort,
): Promise<DemoLeadResult[]> {
  if (!ACCOUNT_ID.test(accountId)) throw new UserFacingError('A valid Atlassian account id is required.');
  const projects = await port.accordProjects();
  if (projects.length === 0) throw new UserFacingError('There are no Accord demo projects yet. Run "Seed demo data" first.');
  for (const project of projects) {
    if (!(await canManage(project.projectKey))) {
      throw new UserFacingError(`Only a Jira site admin or a project administrator of ${project.projectKey} can change the demo lead.`);
    }
  }
  const results: DemoLeadResult[] = [];
  for (const project of projects) {
    const leadChanged = (await port.projectLead(project.projectKey)) !== accountId;
    if (leadChanged) await port.setProjectLead(project.projectKey, accountId);
    const team = await port.refreshTeam(project.projectKey);
    let approversChanged = false;
    let charterValid: boolean | null = null;
    if (team.charterPageId) {
      const approvers = await port.charterApprovers(team.charterPageId);
      approversChanged = approvers.length !== 1 || approvers[0] !== accountId;
      if (approversChanged) await port.setCharterApprovers(team.charterPageId, [accountId]);
      charterValid = await port.syncCharter(team);
    }
    results.push({ projectKey: project.projectKey, team: project.name, leadChanged, approversChanged, charterValid });
  }
  return results;
}

/** Site admin (global ADMINISTER) or ADMINISTER_PROJECTS on the project, checked as the signed-in user. */
export async function userCanManageDemoProjects(): Promise<(projectKey: string) => Promise<boolean>> {
  const global = await myPermissions({ global: true }, ['ADMINISTER'], 'user');
  if (global.has('ADMINISTER')) return async () => true;
  return async (projectKey) => (await myPermissions({ projectKey }, ['ADMINISTER_PROJECTS'], 'user')).has('ADMINISTER_PROJECTS');
}

export const demoLeadPort: DemoLeadPort = {
  async accordProjects() {
    const plans = [];
    for (const team of DEMO_TEAMS) plans.push(await resolveDemoProject(team, false));
    return plans.filter((plan) => plan.state === 'accord').map(({ projectKey, name }) => ({ projectKey, name }));
  },
  async projectLead(projectKey) {
    return (await getProject(projectKey)).lead?.accountId ?? null;
  },
  async setProjectLead(projectKey, accountId) {
    // The app created the demo projects; the signed-in admin is the fallback.
    const errors: string[] = [];
    for (const as of ['app', 'user'] as const) {
      try {
        await jira(route`/rest/api/3/project/${projectKey}`, { method: 'PUT', as, body: { leadAccountId: accountId } });
        return;
      } catch (error) {
        errors.push(`as ${as}: ${error instanceof AtlassianApiError ? `HTTP ${error.status}` : String(error)}`);
        if (!(error instanceof AtlassianApiError)) break;
      }
    }
    console.error(`Setting the lead of ${projectKey} failed`, errors.join('; '));
    throw new UserFacingError(`Could not change the project lead of ${projectKey} (${errors.join('; ')}).`);
  },
  async refreshTeam(projectKey) {
    // registerTeam returns its input (charterPageId null); read the stored row for the charter page.
    const registered = await registerTeam(projectKey);
    return (await getTeamByKey(registered.teamKey)) ?? registered;
  },
  async charterApprovers(pageId) {
    const page = await getPage(pageId);
    const parsed = validateCharterStorage(page.body?.storage?.value ?? '');
    return parsed.charter?.approvers ?? [];
  },
  async setCharterApprovers(pageId, accountIds) {
    const page = await getPage(pageId);
    const storage = replaceApprovers(page.body?.storage?.value ?? '', accountIds);
    if (storage === null) throw new UserFacingError(`Charter page ${pageId} has no Approvers section.`);
    await updatePage(page, storage, 'Accord demo: approver changed');
  },
  async syncCharter(team) {
    return (await syncCharter(team))?.valid ?? null;
  },
};
