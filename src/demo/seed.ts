import { route } from '@forge/api';
import { AtlassianApiError, isNotFound, jira, type Principal } from '../atlassian/http';
import { createSprint, listSprints, moveIssuesToSprint, updateSprint, type JiraSprint } from '../jira/sprints';
import { createIssues, listSprintIssues, searchIssues } from '../jira/issues';
import { UserFacingError } from '../errors';
import { plural } from '../format/text';
import { run, select } from '../sql/db';
import { getTeamByKey, saveThroughput, type Team } from '../teams/repository';
import { createCharterPage, getProject, registerTeam, resolveCharterSpace, TeamSetupError } from '../teams/service';
import {
  DEMO_LABEL,
  DEMO_PROJECT_PROPERTY,
  DEMO_TEAMS,
  SEED_STEPS,
  addDaysIso,
  demoSprintDates,
  demoTeam,
  pickKey,
  projectKeyCandidates,
  simulatedHistory,
  type DemoIssue,
  type DemoTeam,
  type KeyState,
  type SeedStep,
} from './seed-data';

export interface SeedContext {
  /** Lead/approver of the demo projects. */
  leadAccountId: string | null;
  /** Use the projects with the preferred slot keys even if Accord did not create them. */
  adoptExisting: boolean;
  /** Principals tried in order for project creation (`user` only inside resolvers). */
  projectPrincipals: Principal[];
  today: string;
}

export interface SeedStepStatus {
  step: SeedStep;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
  updatedAt: string | null;
}

async function setStatus(step: SeedStep, status: SeedStepStatus['status'], detail: string | null): Promise<void> {
  await run(
    `INSERT INTO demo_seed_steps (step, position, status, detail, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), updated_at = CURRENT_TIMESTAMP`,
    [step, SEED_STEPS.indexOf(step), status, detail ? detail.slice(0, 2000) : null],
  );
}

export async function getSeedStatus(): Promise<SeedStepStatus[]> {
  const rows = await select<{ step: SeedStep; status: SeedStepStatus['status']; detail: string | null; updated_at: string }>(
    'SELECT step, status, detail, updated_at FROM demo_seed_steps ORDER BY position',
  );
  return SEED_STEPS.map((step) => {
    const row = rows.find((candidate) => candidate.step === step);
    return {
      step,
      status: row?.status ?? 'pending',
      detail: row?.detail ?? null,
      updatedAt: row ? String(row.updated_at) : null,
    };
  });
}

async function findLeadAccountId(): Promise<string | null> {
  const page = await jira<{ values: Array<{ lead?: { accountId: string; accountType?: string } }> }>(
    route`/rest/api/3/project/search?expand=lead&maxResults=20`,
  );
  return page.values.find((project) => project.lead?.accountType !== 'app')?.lead?.accountId ?? null;
}

async function hasAccordProperty(projectKey: string): Promise<boolean> {
  try {
    await jira(route`/rest/api/3/project/${projectKey}/properties/${DEMO_PROJECT_PROPERTY}`);
    return true;
  } catch (error) {
    // 403: a project the app may see but not administer is never Accord's.
    if (isNotFound(error) || (error instanceof AtlassianApiError && error.status === 403)) return false;
    throw error;
  }
}

/**
 * Accord's own demo project: it carries the `accord.demo` property, or (seeds that predate the
 * property check) it is registered in this installation's `teams` table under the demo team name.
 */
async function probeDemoProject(projectKey: string, team: DemoTeam): Promise<KeyState> {
  try {
    await getProject(projectKey);
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
  if (await hasAccordProperty(projectKey)) return 'accord';
  const stored = await getTeamByKey(projectKey);
  return stored && stored.name === team.name ? 'accord' : 'foreign';
}

export interface DemoProjectPlan {
  slot: DemoTeam['slot'];
  name: string;
  projectKey: string;
  /** create = key is free; accord = Accord's project; adopted = existing project used on request. */
  state: 'create' | 'accord' | 'adopted';
}

/** Resolves the Jira key a demo team uses (MOB → ACMOB → ACMOB2 … when taken by someone else). */
export async function resolveDemoProject(team: DemoTeam, adoptExisting: boolean): Promise<DemoProjectPlan> {
  const base = { slot: team.slot, name: team.name };
  if (adoptExisting) {
    const state = await probeDemoProject(team.slot, team);
    if (state !== 'missing') return { ...base, projectKey: team.slot, state: state === 'accord' ? 'accord' : 'adopted' };
  }
  const picked = await pickKey(projectKeyCandidates(team.slot), (key) => probeDemoProject(key, team));
  return { ...base, projectKey: picked.key, state: picked.state === 'missing' ? 'create' : 'accord' };
}

export interface SeedPlan {
  projects: DemoProjectPlan[];
  space: { key: string; state: 'create' | 'accord' };
}

export async function getSeedPlan(adoptExisting = false): Promise<SeedPlan> {
  const projects: DemoProjectPlan[] = [];
  for (const team of DEMO_TEAMS) projects.push(await resolveDemoProject(team, adoptExisting));
  const space = await resolveCharterSpace();
  return { projects, space: { key: space.key, state: space.state === 'missing' ? 'create' : 'accord' } };
}

/** Jira admin rights of the signed-in user (checked as the user). */
export interface SeedAccess {
  siteAdmin: boolean;
  projectAdmin(projectKey: string): Promise<boolean>;
}

/**
 * Who may run the demo seed (NFR-3): a Jira site admin, or an admin (ADMINISTER_PROJECTS) of every
 * existing target project. Creating a project needs a site admin. Using an existing project that
 * Accord did not create (`adopted`) needs an admin of that project; the seed then marks it as
 * Accord's (`accord.demo` property, written as that user). Returns null when allowed.
 */
export async function seedAccessError(plan: SeedPlan, access: SeedAccess): Promise<string | null> {
  if (access.siteAdmin) return null;
  for (const project of plan.projects) {
    if (project.state === 'create') {
      return `Only a Jira site admin can create the demo project ${project.projectKey}.`;
    }
    if (!(await access.projectAdmin(project.projectKey))) {
      return `Only a Jira site admin or a project administrator of ${project.projectKey} can seed the demo data.`;
    }
  }
  return null;
}

/** Throws unless the signed-in user may seed; returns the plan the seed will use. */
export async function requireSeedAccess(accountId: string | undefined, adoptExisting: boolean, access: () => Promise<SeedAccess>): Promise<SeedPlan> {
  if (!accountId) throw new UserFacingError('A signed-in Jira user is required.');
  const plan = await getSeedPlan(adoptExisting);
  const error = await seedAccessError(plan, await access());
  if (error) throw new UserFacingError(error);
  return plan;
}

/** Jira key of an existing demo project (e.g. Payments → PAY or ACPAY). */
export async function existingDemoProjectKey(slot: DemoTeam['slot']): Promise<string> {
  const plan = await resolveDemoProject(demoTeam(slot), false);
  if (plan.state === 'create') {
    throw new UserFacingError(`The ${plan.name} demo project does not exist yet. Run "Seed demo data" first.`);
  }
  return plan.projectKey;
}

/** Registered demo team for a slot; throws when the project step has not run yet. */
async function registeredDemoTeam(team: DemoTeam, context: Pick<SeedContext, 'adoptExisting'>): Promise<Team> {
  const plan = await resolveDemoProject(team, context.adoptExisting);
  const stored = plan.state === 'create' ? null : await getTeamByKey(plan.projectKey);
  if (!stored) throw new TeamSetupError(`Team ${team.name} is not registered yet; run the project step first.`);
  return stored;
}

async function ensureProject(team: DemoTeam, context: SeedContext): Promise<string> {
  const plan = await resolveDemoProject(team, context.adoptExisting);
  const projectKey = plan.projectKey;
  const exists = plan.state !== 'create';
  if (!exists) {
    const leadAccountId = context.leadAccountId ?? (await findLeadAccountId());
    if (!leadAccountId) throw new TeamSetupError('No project lead found for the demo projects.');
    const errors: string[] = [];
    let created = false;
    for (const as of context.projectPrincipals) {
      try {
        await jira(route`/rest/api/3/project`, {
          method: 'POST',
          as,
          body: {
            key: projectKey,
            name: team.name,
            projectTypeKey: 'software',
            projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic',
            leadAccountId,
            assigneeType: 'UNASSIGNED',
            description: 'Accord demo team (created by the Accord demo generator).',
          },
        });
        created = true;
        break;
      } catch (error) {
        errors.push(`as ${as}: ${error instanceof AtlassianApiError ? `HTTP ${error.status} ${error.detail.slice(0, 200)}` : String(error)}`);
      }
    }
    if (!created) {
      throw new TeamSetupError(
        `Could not create project ${projectKey} (${errors.join('; ')}). A Jira admin can create a company-managed Scrum project "${team.name}" with key ${projectKey} and re-run the seed with "Use existing projects".`,
      );
    }
    await jira(route`/rest/api/3/project/${projectKey}/properties/${DEMO_PROJECT_PROPERTY}`, {
      method: 'PUT',
      body: { createdBy: 'accord', createdAt: new Date().toISOString() },
    });
  } else if (plan.state === 'adopted') {
    // Hand-made project used on request: the caller (a project admin, checked by the resolver) marks it
    // as Accord's. Written as the user, so this fails for anyone who cannot administer the project.
    const as = context.projectPrincipals.includes('user') ? 'user' : 'app';
    await jira(route`/rest/api/3/project/${projectKey}/properties/${DEMO_PROJECT_PROPERTY}`, {
      method: 'PUT',
      as,
      body: { createdBy: 'adopted', adoptedAt: new Date().toISOString() },
    });
  }
  const registered = await registerTeam(projectKey);
  const note = projectKey === team.slot ? '' : ` (${team.slot} is used by another project)`;
  return `${exists ? 'Using' : 'Created'} project ${projectKey}${note}, Scrum board ${registered.boardId}`;
}

const sprintTime = (date: string, endOfDay = false) => `${date}T${endOfDay ? '17:00' : '09:00'}:00.000Z`;

async function ensureSprint(
  boardId: number,
  sprints: JiraSprint[],
  claimed: Set<number>,
  name: string,
  start: string,
  end: string,
): Promise<JiraSprint> {
  const byName = sprints.find((sprint) => sprint.name === name);
  if (byName) {
    claimed.add(byName.id);
    return byName;
  }
  // Reuse the empty "KEY Sprint 1" that Jira creates with a new Scrum project.
  for (const sprint of sprints) {
    if (sprint.state !== 'future' || claimed.has(sprint.id)) continue;
    if ((await listSprintIssues(sprint.id)).length > 0) continue;
    claimed.add(sprint.id);
    return updateSprint(sprint.id, { name, startDate: sprintTime(start), endDate: sprintTime(end, true) });
  }
  const created = await createSprint(boardId, name, sprintTime(start), sprintTime(end, true));
  claimed.add(created.id);
  return created;
}

async function ensureSprintsAndIssues(team: DemoTeam, context: SeedContext): Promise<string> {
  // Resolution only returns foreign projects when adoptExisting is set (NFR-2 guard).
  const stored = await registeredDemoTeam(team, context);
  if (!stored.boardId) throw new TeamSetupError(`Team ${stored.teamKey} has no Scrum board; run the project step first.`);
  const projectKey = stored.jiraProjectKey;
  const dates = demoSprintDates(context.today);
  const existing = new Map(
    (await searchIssues(`project = "${projectKey}" AND labels = "${DEMO_LABEL}"`, 200)).map((issue) => [
      issue.fields.summary ?? '',
      issue.key,
    ]),
  );
  const ensureIssues = async (issues: DemoIssue[]): Promise<string[]> => {
    const missing = issues.filter((item) => !existing.has(item.summary));
    if (missing.length) {
      const keys = await createIssues(
        missing.map((item) => ({
          projectKey,
          summary: item.summary,
          issueType: item.issueType,
          priority: item.priority,
          labels: [DEMO_LABEL, ...item.labels],
          dueDate:
            item.dueInDaysAfterSprintEnd === undefined ? undefined : addDaysIso(dates.activeEnd, item.dueInDaysAfterSprintEnd),
        })),
      );
      missing.forEach((item, index) => existing.set(item.summary, keys[index]));
    }
    return issues.map((item) => existing.get(item.summary) as string);
  };
  const activeKeys = await ensureIssues(team.activeIssues);
  const nextKeys = await ensureIssues(team.nextIssues);

  const sprints = await listSprints(stored.boardId, ['active', 'future']);
  const claimed = new Set<number>();
  const active = await ensureSprint(
    stored.boardId,
    sprints,
    claimed,
    `${team.name} Sprint ${team.sprintNumbers.active}`,
    dates.activeStart,
    dates.activeEnd,
  );
  const next = await ensureSprint(
    stored.boardId,
    sprints,
    claimed,
    `${team.name} Sprint ${team.sprintNumbers.next}`,
    dates.nextStart,
    dates.nextEnd,
  );
  await moveIssuesToSprint(active.id, activeKeys);
  await moveIssuesToSprint(next.id, nextKeys);
  if (active.state === 'future') {
    await updateSprint(active.id, {
      state: 'active',
      startDate: sprintTime(dates.activeStart),
      endDate: sprintTime(dates.activeEnd, true),
    });
  }
  return `${projectKey}: sprint ${active.id} (${plural(activeKeys.length, 'issue')}, active), sprint ${next.id} (${plural(nextKeys.length, 'issue')})`;
}

async function ensureCharter(team: DemoTeam, context: SeedContext): Promise<string> {
  const stored = await registeredDemoTeam(team, context);
  // The Jira project lead approves (for projects the seed created, that is the account that ran it);
  // never the caller of an existing project they do not lead. The same lead is the escalation contact (FR-15).
  const lead = stored.leadAccountId ?? context.leadAccountId;
  const result = await createCharterPage(stored, {
    teamName: team.name,
    ...team.charter,
    approverAccountIds: lead ? [lead] : [],
    ...(lead ? { escalationAccountId: lead } : {}),
  });
  const status = result.charter?.valid ? 'Charter valid' : `missing: ${result.charter?.missingFields.join(', ')}`;
  return `${stored.jiraProjectKey}: page ${result.pageId} ${result.created ? 'created' : 'reused'} (${status})`;
}

async function ensureHistory(context: SeedContext): Promise<string> {
  const parts: string[] = [];
  for (const team of DEMO_TEAMS) {
    const stored = await registeredDemoTeam(team, context);
    const samples = simulatedHistory(team, context.today, stored.jiraProjectKey);
    await run("DELETE FROM throughput_samples WHERE team_id = ? AND source = 'simulated'", [stored.id]);
    await saveThroughput(stored.id, samples);
    parts.push(`${stored.jiraProjectKey}: ${samples.length} simulated sprints`);
  }
  return parts.join('; ');
}

export async function runSeedStep(step: SeedStep, context: SeedContext): Promise<string> {
  const [kind, key] = step.split(':');
  switch (kind) {
    case 'project':
      return ensureProject(demoTeam(key), context);
    case 'sprints':
      return ensureSprintsAndIssues(demoTeam(key), context);
    case 'charter':
      return ensureCharter(demoTeam(key), context);
    case 'history':
      return ensureHistory(context);
    default:
      throw new Error(`Unknown seed step ${step}`);
  }
}

/** Runs one step, records the outcome and returns whether the chain may continue. */
export async function executeSeedStep(step: SeedStep, context: SeedContext): Promise<boolean> {
  await setStatus(step, 'running', null);
  try {
    await setStatus(step, 'done', await runSeedStep(step, context));
    return true;
  } catch (error) {
    await setStatus(step, 'failed', error instanceof Error ? error.message : String(error));
    return false;
  }
}

