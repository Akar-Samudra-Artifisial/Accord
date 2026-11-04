import { route } from '@forge/api';
import { Queue } from '@forge/events';
import { AtlassianApiError, isNotFound, jira, type Principal } from '../atlassian/http';
import { createSprint, listSprints, moveIssuesToSprint, updateSprint, type JiraSprint } from '../jira/sprints';
import { createIssues, listSprintIssues, searchIssues } from '../jira/issues';
import { run, select } from '../sql/db';
import { getTeamByKey, saveThroughput } from '../teams/repository';
import { createCharterPage, getProject, registerTeam, TeamSetupError } from '../teams/service';
import {
  DEMO_LABEL,
  DEMO_PROJECT_PROPERTY,
  DEMO_TEAMS,
  SEED_STEPS,
  addDaysIso,
  demoSprintDates,
  demoTeam,
  simulatedHistory,
  type DemoIssue,
  type DemoTeam,
  type SeedStep,
} from './seed-data';

export const SEED_QUEUE_KEY = 'accord-demo-seed';

export interface SeedContext {
  /** Lead/approver of the demo projects. */
  leadAccountId: string | null;
  /** Use MOB/PAY even if they were not created by Accord (user created them manually). */
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

const todayIso = () => new Date().toISOString().slice(0, 10);

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

async function isAccordProject(projectKey: string): Promise<boolean> {
  try {
    await jira(route`/rest/api/3/project/${projectKey}/properties/${DEMO_PROJECT_PROPERTY}`);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function ensureProject(team: DemoTeam, context: SeedContext): Promise<string> {
  let exists = true;
  try {
    await getProject(team.projectKey);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    exists = false;
  }
  if (exists) {
    if (!(await isAccordProject(team.projectKey)) && !context.adoptExisting) {
      throw new TeamSetupError(
        `Project ${team.projectKey} already exists and was not created by Accord. Accord will not change it unless you choose "Use existing projects".`,
      );
    }
  } else {
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
            key: team.projectKey,
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
        `Could not create project ${team.projectKey} (${errors.join('; ')}). A Jira admin can create a company-managed Scrum project "${team.name}" with key ${team.projectKey} and re-run the seed with "Use existing projects".`,
      );
    }
    await jira(route`/rest/api/3/project/${team.projectKey}/properties/${DEMO_PROJECT_PROPERTY}`, {
      method: 'PUT',
      body: { createdBy: 'accord', createdAt: new Date().toISOString() },
    });
  }
  const registered = await registerTeam(team.projectKey);
  return `${exists ? 'Using' : 'Created'} project ${team.projectKey}, Scrum board ${registered.boardId}`;
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
  const stored = await getTeamByKey(team.projectKey);
  if (!stored?.boardId) throw new TeamSetupError(`Team ${team.projectKey} is not registered yet; run the project step first.`);
  if (!(await isAccordProject(team.projectKey)) && !context.adoptExisting) {
    throw new TeamSetupError(`Project ${team.projectKey} was not created by Accord; refusing to add issues.`);
  }
  const dates = demoSprintDates(context.today);
  const existing = new Map(
    (await searchIssues(`project = "${team.projectKey}" AND labels = "${DEMO_LABEL}"`, 200)).map((issue) => [
      issue.fields.summary ?? '',
      issue.key,
    ]),
  );
  const ensureIssues = async (issues: DemoIssue[]): Promise<string[]> => {
    const missing = issues.filter((item) => !existing.has(item.summary));
    if (missing.length) {
      const keys = await createIssues(
        missing.map((item) => ({
          projectKey: team.projectKey,
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
  return `${team.projectKey}: sprint ${active.id} (${activeKeys.length} issues, active), sprint ${next.id} (${nextKeys.length} issues)`;
}

async function ensureCharter(team: DemoTeam): Promise<string> {
  const stored = await getTeamByKey(team.projectKey);
  if (!stored) throw new TeamSetupError(`Team ${team.projectKey} is not registered yet.`);
  const result = await createCharterPage(stored, {
    teamName: team.name,
    ...team.charter,
    approverAccountIds: stored.leadAccountId ? [stored.leadAccountId] : [],
  });
  const status = result.charter?.valid ? 'Charter valid' : `missing: ${result.charter?.missingFields.join(', ')}`;
  return `${team.projectKey}: page ${result.pageId} ${result.created ? 'created' : 'reused'} (${status})`;
}

async function ensureHistory(context: SeedContext): Promise<string> {
  const parts: string[] = [];
  for (const team of DEMO_TEAMS) {
    const stored = await getTeamByKey(team.projectKey);
    if (!stored) throw new TeamSetupError(`Team ${team.projectKey} is not registered yet.`);
    const samples = simulatedHistory(team, context.today);
    await run("DELETE FROM throughput_samples WHERE team_id = ? AND source = 'simulated'", [stored.id]);
    await saveThroughput(stored.id, samples);
    parts.push(`${team.projectKey}: ${samples.length} simulated sprints`);
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
      return ensureCharter(demoTeam(key));
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

export interface SeedEvent extends Record<string, unknown> {
  kind: 'seed-step';
  step: SeedStep;
  leadAccountId: string | null;
  adoptExisting: boolean;
  today: string;
}

const queue = new Queue({ key: SEED_QUEUE_KEY });

export async function enqueueSeedStep(event: Omit<SeedEvent, 'kind'>): Promise<string> {
  const { jobId } = await queue.push({ body: { kind: 'seed-step', ...event } });
  return jobId;
}

export function nextSeedStep(step: SeedStep): SeedStep | null {
  const index = SEED_STEPS.indexOf(step);
  return index >= 0 && index < SEED_STEPS.length - 1 ? SEED_STEPS[index + 1] : null;
}

/**
 * Starts the demo seed. `inlineSteps` run synchronously first (resolvers use
 * this to create projects as the signed-in admin); the rest run on the queue.
 */
export async function startSeed(options: {
  leadAccountId: string | null;
  adoptExisting: boolean;
  inlineProjectPrincipals?: Principal[];
}): Promise<{ jobId: string | null; failedStep: SeedStep | null }> {
  const today = todayIso();
  for (const step of SEED_STEPS) await setStatus(step, 'pending', null);
  let first: SeedStep = SEED_STEPS[0];
  if (options.inlineProjectPrincipals) {
    const context: SeedContext = {
      leadAccountId: options.leadAccountId,
      adoptExisting: options.adoptExisting,
      projectPrincipals: options.inlineProjectPrincipals,
      today,
    };
    for (const step of ['project:MOB', 'project:PAY'] as const) {
      if (!(await executeSeedStep(step, context))) return { jobId: null, failedStep: step };
    }
    first = 'sprints:MOB';
  }
  const jobId = await enqueueSeedStep({
    step: first,
    leadAccountId: options.leadAccountId,
    adoptExisting: options.adoptExisting,
    today,
  });
  return { jobId, failedStep: null };
}

/** Queue consumer body: run the step, then enqueue the next one (one step per invocation, NFR-6). */
export async function handleSeedEvent(event: SeedEvent): Promise<void> {
  const ok = await executeSeedStep(event.step, {
    leadAccountId: event.leadAccountId,
    adoptExisting: event.adoptExisting,
    projectPrincipals: ['app'],
    today: event.today,
  });
  const next = nextSeedStep(event.step);
  if (ok && next) await enqueueSeedStep({ ...event, step: next });
}
