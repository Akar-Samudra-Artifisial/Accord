import { route } from '@forge/api';
import { AtlassianApiError, jira } from '../atlassian/http';
import { CHARTER_LABEL, replaceApprovers, validateCharterStorage } from '../confluence/charter';
import { getPage, getPageLabels, updatePage } from '../confluence/pages';
import { UserFacingError } from '../errors';
import { myPermissions } from '../jira/permissions';
import { getTeamByKey, listTeams, type Team } from '../teams/repository';
import { getProject, registerTeam, syncCharter } from '../teams/service';
import { DEMO_TEAMS } from './seed-data';
import { resolveDemoProject, type SeedAccess } from './seed';

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

/** Site admin (global ADMINISTER) or ADMINISTER_PROJECTS per project, checked as the signed-in user. */
export async function userSeedAccess(): Promise<SeedAccess> {
  const global = await myPermissions({ global: true }, ['ADMINISTER'], 'user');
  return {
    siteAdmin: global.has('ADMINISTER'),
    projectAdmin: async (projectKey) => (await myPermissions({ projectKey }, ['ADMINISTER_PROJECTS'], 'user')).has('ADMINISTER_PROJECTS'),
  };
}

/** Site admin (global ADMINISTER) or ADMINISTER_PROJECTS on the project, checked as the signed-in user. */
export async function userCanManageDemoProjects(): Promise<(projectKey: string) => Promise<boolean>> {
  const access = await userSeedAccess();
  if (access.siteAdmin) return async () => true;
  return access.projectAdmin;
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
  /**
   * Edits the charter as the signed-in user. Only when the user cannot edit the page does the app
   * step in, and only for a page that is the registered charter of an Accord team with the
   * `accord-charter` label; `assignDemoLead` has already checked that the caller is a project admin.
   */
  async setCharterApprovers(pageId, accountIds) {
    const page = await getPage(pageId);
    const storage = replaceApprovers(page.body?.storage?.value ?? '', accountIds);
    if (storage === null) throw new UserFacingError(`Charter page ${pageId} has no Approvers section.`);
    try {
      await updatePage(page, storage, 'Accord demo: approver changed', 'user');
      return;
    } catch (error) {
      if (!(error instanceof AtlassianApiError) || ![401, 403, 404].includes(error.status)) throw error;
    }
    const registered = (await listTeams()).some((team) => team.charterPageId === pageId);
    if (!registered || !(await getPageLabels(pageId)).includes(CHARTER_LABEL)) {
      throw new UserFacingError(`You cannot edit charter page ${pageId}, and it is not an Accord charter page.`);
    }
    await updatePage(page, storage, 'Accord demo: approver changed', 'app');
  },
  async syncCharter(team) {
    return (await syncCharter(team))?.valid ?? null;
  },
};
