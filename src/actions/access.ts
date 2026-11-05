import { UserFacingError } from '../errors';
import type { Team } from '../teams/repository';
import type { Viewer } from './handlers';

export const TEAM_ACCESS_DENIED = 'You do not have access to this team.';

export interface TeamAccessChecks {
  /** Charter approvers plus the Jira project lead. */
  approvers(team: Team): Promise<string[]>;
  /** Whether the viewer (`as`) may browse the Jira project. */
  canBrowseProject(projectKey: string, viewer: Viewer): Promise<boolean>;
}

/**
 * Team data (charter, capacity) is shown to the team's approvers/lead or to users who can
 * browse the team's Jira project (checked as the user). Everyone else gets one generic error,
 * also when the permission check itself fails (fail closed).
 */
export async function requireTeamAccess(team: Team, viewer: Viewer, checks: TeamAccessChecks): Promise<void> {
  if (!viewer.accountId) throw new UserFacingError('A signed-in Jira user is required.');
  if (!(await hasTeamAccess(team, viewer, checks))) throw new UserFacingError(TEAM_ACCESS_DENIED);
}

/** Same rule as `requireTeamAccess`, as a boolean: approver/lead or Browse; a failed check counts as no access. */
export async function hasTeamAccess(team: Team, viewer: Viewer, checks: TeamAccessChecks): Promise<boolean> {
  if (!viewer.accountId) return false;
  if ((await checks.approvers(team)).includes(viewer.accountId)) return true;
  try {
    return await checks.canBrowseProject(team.jiraProjectKey, viewer);
  } catch (error) {
    console.error(`Accord team access check for ${team.teamKey} failed`, error instanceof Error ? error.message : String(error));
    return false;
  }
}
