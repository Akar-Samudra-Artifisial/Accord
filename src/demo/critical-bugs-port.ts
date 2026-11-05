import { Queue } from '@forge/events';
import { createIssues, searchIssues } from '../jira/issues';
import { listSprints, moveIssuesToBacklog, moveIssuesToSprint } from '../jira/sprints';
import { MONITOR_QUEUE_KEY, nearestContractProjection, type MonitorEvent } from '../monitor/monitor';
import { monitorDeps } from '../monitor/deps';
import { select } from '../sql/db';
import { audit, getTeamByKey } from '../teams/repository';
import { DEMO_BUG_LABEL, LEGACY_DEMO_BUG_LABEL, MAX_DEMO_BUGS, type DemoBugPort } from './critical-bugs';

const ENTITY = ['demo', 'critical-bugs'] as const;

async function requireTeam(projectKey: string) {
  const team = await getTeamByKey(projectKey);
  if (!team) throw new Error(`Demo team ${projectKey} is not registered`);
  return team;
}

export const demoBugPort: DemoBugPort = {
  async findBugs(projectKey) {
    const issues = await searchIssues(
      `project = "${projectKey}" AND labels in ("${DEMO_BUG_LABEL}", "${LEGACY_DEMO_BUG_LABEL}") AND statusCategory != Done ORDER BY created ASC`,
      MAX_DEMO_BUGS * 2,
    );
    return issues.map((issue) => ({ key: issue.key, summary: issue.fields.summary ?? '' }));
  },
  createBugs: (projectKey, bugs) =>
    createIssues(bugs.map((bug) => ({ projectKey, summary: bug.summary, issueType: bug.issueType, priority: bug.priority, labels: bug.labels }))),
  async activeSprint(projectKey) {
    const team = await getTeamByKey(projectKey);
    if (!team?.boardId) return null;
    const [active] = await listSprints(team.boardId, ['active']);
    return active ? { id: Number(active.id), name: active.name } : null;
  },
  async nearestContract(projectKey) {
    return nearestContractProjection(monitorDeps, (await requireTeam(projectKey)).id);
  },
  moveToSprint: moveIssuesToSprint,
  moveToBacklog: moveIssuesToBacklog,
  async queueMonitor(projectKey) {
    const body: MonitorEvent = { type: 'monitor-team', teamId: (await requireTeam(projectKey)).id };
    // A short delay lets the Jira sprint moves settle before the monitor reads the sprint.
    await new Queue({ key: MONITOR_QUEUE_KEY }).push({ body, delayInSeconds: 3 });
  },
  async lastIntentAgeSeconds() {
    const rows = await select<{ age: number | null }>(
      `SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), CURRENT_TIMESTAMP) AS age FROM audit_log
       WHERE entity_type = ? AND entity_id = ? AND action = 'demo-bugs-intent'`,
      [...ENTITY],
    );
    const age = rows[0]?.age;
    return age === null || age === undefined ? null : Number(age);
  },
  audit: (action, actor, payload) => audit(ENTITY[0], ENTITY[1], action, actor, payload),
};
