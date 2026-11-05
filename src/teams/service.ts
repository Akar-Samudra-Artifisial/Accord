import { route } from '@forge/api';
import { AtlassianApiError, isNotFound, jira, type Principal } from '../atlassian/http';
import { keyCandidates, pickKey, type KeyState } from '../demo/seed-data';
import { UserFacingError } from '../errors';
import { accountProjectPermissions, myPermissions, type JiraPermission } from '../jira/permissions';
import { findScrumBoard } from '../jira/boards';
import { listSprints, toPlannerSprint } from '../jira/sprints';
import { listSprintIssues, searchIssues } from '../jira/issues';
import {
  buildCharterStorage,
  charterPageTitle,
  validateCharterStorage,
  type CharterTemplateInput,
  type CharterValidation,
} from '../confluence/charter';
import {
  addCharterLabel,
  createPage,
  createSpace,
  findPageByTitle,
  getPage,
  getSpaceByKey,
  listSpaces,
  type Space,
} from '../confluence/pages';
import {
  buildCommitments,
  capacityFromSamples,
  latestSamples,
  pickActiveAndNext,
  sampleFromClosedSprint,
  withInferredDates,
  type TeamCapacity,
  type ThroughputSample,
} from '../capacity/aggregate';
import { CAPACITY_WINDOW, isValidIsoDate, type Sprint, type WorkItem } from '../planner';
import {
  audit,
  getCharter,
  listTeams,
  listThroughput,
  saveApproverCheck,
  saveCharter,
  saveThroughput,
  setCharterPage,
  upsertTeam,
  type StoredCharter,
  type Team,
} from './repository';

/** Space that holds charter pages created by Accord. */
export const CHARTER_SPACE_KEY = 'ACCORD';
const CHARTER_SPACE_NAME = 'Accord team charters';

export class TeamSetupError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamSetupError';
  }
}

interface JiraProject {
  id: string;
  key: string;
  name: string;
  lead?: { accountId: string };
}

export async function getProject(projectKey: string, as: Principal = 'app'): Promise<JiraProject> {
  return jira<JiraProject>(route`/rest/api/3/project/${projectKey}`, { as });
}

/**
 * Team administration (register, charter page, charter sync) is limited to the Jira
 * project lead or users with ADMINISTER_PROJECTS on that project. The project is read as the
 * user, and "does not exist" and "not allowed" give the same message, so the check reveals nothing.
 * Returns the project so callers can reuse its lead.
 */
export async function requireProjectAdmin(projectKey: string, accountId: string | undefined): Promise<JiraProject> {
  if (!accountId) throw new UserFacingError('A signed-in Jira user is required.');
  const denied = () =>
    new UserFacingError(`Only the project lead or a project administrator of ${projectKey} can change its Accord team setup.`);
  let project: JiraProject;
  try {
    project = await getProject(projectKey, 'user');
  } catch (error) {
    if (error instanceof AtlassianApiError && [401, 403, 404].includes(error.status)) throw denied();
    throw error;
  }
  if (project.lead?.accountId === accountId) return project;
  const granted = await myPermissions({ projectKey: project.key }, ['ADMINISTER_PROJECTS']);
  if (!granted.has('ADMINISTER_PROJECTS')) throw denied();
  return project;
}

/** Jira permissions a charter approver needs in the team's project to be counted (NFR-3). */
export const APPROVER_PERMISSIONS = ['BROWSE_PROJECTS', 'SCHEDULE_ISSUES'] as const satisfies readonly JiraPermission[];

/**
 * Splits the approvers mentioned on a charter page into those that hold `APPROVER_PERMISSIONS` in
 * the team project and those that do not. Anyone who can edit the page can mention anyone, so the
 * page alone never makes someone an approver. A failed check ignores the approver (fail closed).
 */
export async function partitionApprovers(
  approvers: readonly string[],
  hasPermissions: (accountId: string) => Promise<boolean>,
): Promise<{ kept: string[]; ignored: string[] }> {
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const accountId of approvers) {
    let allowed = false;
    try {
      allowed = await hasPermissions(accountId);
    } catch (error) {
      console.error('Accord approver permission check failed', error instanceof Error ? error.message : String(error));
    }
    (allowed ? kept : ignored).push(accountId);
  }
  return { kept, ignored };
}

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** Checks an approver's project permissions as the app (`permissions/check` with `accountId`). */
async function approverPermissionCheck(team: Team): Promise<(accountId: string) => Promise<boolean>> {
  const project = await getProject(team.jiraProjectKey);
  return async (accountId) => {
    const held = await accountProjectPermissions(accountId, project.id, APPROVER_PERMISSIONS);
    return APPROVER_PERMISSIONS.every((permission) => held.has(permission));
  };
}

/** Registers (or refreshes) a Jira project as an Accord team. Requires a Scrum board. */
export async function registerTeam(projectKey: string): Promise<Team> {
  const project = await getProject(projectKey);
  const lookup = await findScrumBoard(project.key);
  if (lookup.status !== 'ok') {
    const found = lookup.boards.map((board) => `${board.name} (${board.type})`).join(', ') || 'none';
    throw new TeamSetupError(
      `Project ${project.key} has no Scrum board (boards found: ${found}). Accord plans in sprints, so Kanban-only projects cannot be teams yet.`,
    );
  }
  return upsertTeam({
    teamKey: project.key,
    name: project.name,
    jiraProjectKey: project.key,
    boardId: lookup.board.id,
    leadAccountId: project.lead?.accountId ?? null,
    charterPageId: null,
  });
}

/**
 * Reads the charter page, validates it and stores the parsed result. Approvers without
 * `APPROVER_PERMISSIONS` in the team project are dropped (count shown in Teams); a change of the
 * effective approver list since the last sync is audited and shown as "Approvers changed".
 */
export async function syncCharter(
  team: Team,
  hasPermissions?: (accountId: string) => Promise<boolean>,
): Promise<StoredCharter | null> {
  if (!team.charterPageId) return null;
  const page = await getPage(team.charterPageId);
  const parsed: CharterValidation = validateCharterStorage(page.body?.storage?.value ?? '');
  let validation = parsed;
  let ignored: string[] = [];
  if (parsed.charter) {
    const check = hasPermissions ?? (await approverPermissionCheck(team));
    const split = await partitionApprovers(parsed.charter.approvers, check);
    ignored = split.ignored;
    validation = { ...parsed, charter: { ...parsed.charter, approvers: split.kept } };
  }
  const previous = (await getCharter(team.id))?.charter?.approvers ?? null;
  const current = validation.charter?.approvers ?? null;
  const changed = previous !== null && current !== null && !sameMembers(previous, current);
  await saveCharter(team.id, page.id, page.version.number, validation);
  await saveApproverCheck(team.id, ignored, changed);
  if (changed) {
    await audit('team', team.id, 'charter-approvers-changed', null, {
      pageVersion: page.version.number,
      before: previous,
      after: current,
    });
  }
  if (ignored.length > 0) {
    await audit('team', team.id, 'charter-approvers-ignored', null, {
      pageVersion: page.version.number,
      ignored,
      required: APPROVER_PERMISSIONS,
    });
  }
  return getCharter(team.id);
}

/** Uses the Accord space, creating it when missing; falls back to the first global space. */
/**
 * A space is Accord's when it carries the Accord space name or already holds the charter page of
 * a registered team (spaces created before the name check). Space properties would need extra scopes.
 */
async function probeCharterSpace(key: string, spaces: Map<string, Space>, charterPageIds: () => Promise<string[]>): Promise<KeyState> {
  const space = await getSpaceByKey(key);
  if (!space) return 'missing';
  spaces.set(key, space);
  if (space.name === CHARTER_SPACE_NAME) return 'accord';
  for (const pageId of await charterPageIds()) {
    try {
      if ((await getPage(pageId)).spaceId === space.id) return 'accord';
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return 'foreign';
}

export interface CharterSpacePlan {
  key: string;
  state: 'missing' | 'accord';
  space: Space | null;
}

/** ACCORD, then ACCORD2 … when the key is taken by a space Accord did not create. */
export async function resolveCharterSpace(): Promise<CharterSpacePlan> {
  const spaces = new Map<string, Space>();
  let pageIds: string[] | null = null;
  const charterPageIds = async () =>
    (pageIds ??= (await listTeams()).map((team) => team.charterPageId).filter((id): id is string => Boolean(id)));
  const { key, state } = await pickKey(keyCandidates(CHARTER_SPACE_KEY, CHARTER_SPACE_KEY), (candidate) =>
    probeCharterSpace(candidate, spaces, charterPageIds),
  );
  return { key, state, space: spaces.get(key) ?? null };
}

export async function ensureCharterSpace(as: Principal = 'app'): Promise<Space> {
  const plan = await resolveCharterSpace();
  if (plan.space) return plan.space;
  try {
    return await createSpace(plan.key, CHARTER_SPACE_NAME, as);
  } catch (error) {
    const fallback = (await listSpaces()).find((space) => space.type === 'global' && space.status !== 'archived');
    if (fallback) return fallback;
    console.error(`Creating Confluence space ${plan.key} failed`, error instanceof Error ? error.message : error);
    throw new TeamSetupError(`Could not create the Confluence space ${plan.key} and no global space exists.`);
  }
}

/** Default rules for a new charter; the team reviews them on the page. */
export function defaultCharterTemplate(team: Team, approverAccountId: string | null): CharterTemplateInput {
  return {
    teamName: team.name,
    priorities: ['Replace with your first quarter goal', 'Replace with your second quarter goal'],
    redLines: [
      { field: 'label', value: 'security' },
      { field: 'issueType', value: 'Incident' },
    ],
    shiftable: [
      { field: 'priority', value: 'Low' },
      { field: 'priority', value: 'Medium' },
      { field: 'label', value: 'tech-debt' },
    ],
    maxExternalShare: 0.25,
    responseDays: 2,
    approverAccountIds: approverAccountId ? [approverAccountId] : [],
  };
}

/** Creates (or adopts an existing same-titled) charter page for the team, labels it and syncs it. */
export async function createCharterPage(
  team: Team,
  template: CharterTemplateInput,
  as: Principal = 'app',
): Promise<{ pageId: string; created: boolean; charter: StoredCharter | null }> {
  const space = await ensureCharterSpace(as);
  const title = charterPageTitle(team.name);
  const existing = await findPageByTitle(space.id, title);
  const page = existing ?? (await createPage(space.id, title, buildCharterStorage(template), as));
  await addCharterLabel(page.id, as);
  await setCharterPage(team.id, page.id);
  const charter = await syncCharter({ ...team, charterPageId: page.id });
  return { pageId: page.id, created: !existing, charter };
}

/**
 * Pulls completed-issue counts of the last closed sprints from Jira and
 * stores them (source `jira`). Bounded to CAPACITY_WINDOW sprints (NFR-6).
 */
export async function refreshJiraThroughput(team: Team): Promise<ThroughputSample[]> {
  if (!team.boardId) return [];
  const closed = (await listSprints(team.boardId, ['closed']))
    .map(toPlannerSprint)
    .filter((sprint): sprint is Sprint => sprint !== null)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(-CAPACITY_WINDOW);
  const samples: ThroughputSample[] = [];
  for (const sprint of closed) {
    samples.push(sampleFromClosedSprint(sprint, await listSprintIssues(Number(sprint.id))));
  }
  await saveThroughput(team.id, samples);
  return samples;
}

export async function teamCapacity(team: Team): Promise<TeamCapacity> {
  return capacityFromSamples(latestSamples(await listThroughput(team.id)));
}

export interface TeamCommitments {
  sprints: Sprint[];
  commitments: WorkItem[];
}

/** Active + next sprint issues and open issues due before `neededBy`. */
export async function loadCommitments(team: Team, neededBy?: string): Promise<TeamCommitments> {
  if (neededBy !== undefined && !isValidIsoDate(neededBy)) {
    throw new Error(`neededBy must be a YYYY-MM-DD date, got "${neededBy}"`);
  }
  if (!team.boardId) return { sprints: [], commitments: [] };
  const dated = withInferredDates(await listSprints(team.boardId, ['active', 'future']));
  const sprints = pickActiveAndNext(dated);
  const sprintIssues = [];
  for (const sprint of sprints) {
    sprintIssues.push({ sprint, issues: await listSprintIssues(Number(sprint.id)) });
  }
  const dueIssues = neededBy
    ? await searchIssues(
        `project = "${team.jiraProjectKey}" AND duedate < "${neededBy}" AND statusCategory != Done ORDER BY duedate`,
        200,
      )
    : [];
  return { sprints: dated, commitments: buildCommitments(sprintIssues, dueIssues, neededBy) };
}
