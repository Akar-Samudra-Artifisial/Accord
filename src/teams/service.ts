import { route } from '@forge/api';
import { jira, type Principal } from '../atlassian/http';
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
  getCharter,
  listThroughput,
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

export class TeamSetupError extends Error {
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

export async function getProject(projectKey: string): Promise<JiraProject> {
  return jira<JiraProject>(route`/rest/api/3/project/${projectKey}`);
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

/** Reads the charter page, validates it and stores the parsed result. */
export async function syncCharter(team: Team): Promise<StoredCharter | null> {
  if (!team.charterPageId) return null;
  const page = await getPage(team.charterPageId);
  const validation: CharterValidation = validateCharterStorage(page.body?.storage?.value ?? '');
  await saveCharter(team.id, page.id, page.version.number, validation);
  return getCharter(team.id);
}

/** Uses the Accord space, creating it when missing; falls back to the first global space. */
export async function ensureCharterSpace(as: Principal = 'app'): Promise<Space> {
  const existing = await getSpaceByKey(CHARTER_SPACE_KEY);
  if (existing) return existing;
  try {
    return await createSpace(CHARTER_SPACE_KEY, CHARTER_SPACE_NAME, as);
  } catch (error) {
    const fallback = (await listSpaces()).find((space) => space.type === 'global' && space.status !== 'archived');
    if (fallback) return fallback;
    throw new TeamSetupError(
      `Could not create the Confluence space ${CHARTER_SPACE_KEY} and no global space exists: ${String(error)}`,
    );
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
