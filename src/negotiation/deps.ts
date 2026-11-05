import { Queue } from '@forge/events';
import {
  addComment,
  createIssue,
  isBlocksFrom,
  ISSUE_KEY,
  listIssueLinks,
  linkBlocks,
  searchIssues,
  updateDueDate,
  userDisplayName,
} from '../jira/issues';
import { moveIssuesToBacklog, moveIssuesToSprint } from '../jira/sprints';
import { getCharter, getTeamById, type Team } from '../teams/repository';
import { getProject, loadCommitments, teamCapacity } from '../teams/service';
import { accountProjectPermissions, myPermissions } from '../jira/permissions';
import { sqlStore } from './store';
import type { JiraPort, NegotiationDeps, QueuePort, TeamDirectory } from './types';
import { MONITOR_QUEUE_KEY, providerWorkAhead, type MonitorEvent } from '../monitor/monitor';
import { monitorDeps } from '../monitor/deps';

export const NEGOTIATION_QUEUE_KEY = 'accord-negotiation';

const LABEL = /^[a-z0-9-]{1,100}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/** ADF mentions only accept Atlassian account ids. */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const jiraPort: JiraPort = {
  async addComment(issueKey, text, mentions = []) {
    await addComment(issueKey, text, mentions.filter((id) => ACCOUNT_ID.test(id)));
  },
  async setDueDate(issueKey, dueDate) {
    if (!ISSUE_KEY.test(issueKey)) throw new Error(`Invalid issue key "${issueKey}"`);
    if (!ISO_DATE.test(dueDate)) throw new Error(`Invalid due date "${dueDate}"`);
    await updateDueDate(issueKey, dueDate);
  },
  async displayName(accountId) {
    if (!ACCOUNT_ID.test(accountId)) return null;
    try {
      return await userDisplayName(accountId);
    } catch (error) {
      console.error('Accord display name lookup failed', error instanceof Error ? error.message : String(error));
      return null;
    }
  },
  async findIssueByLabel(projectKey, label) {
    if (!LABEL.test(label)) throw new Error(`Invalid contract label "${label}"`);
    if (!PROJECT_KEY.test(projectKey)) throw new Error(`Invalid project key "${projectKey}"`);
    const issues = await searchIssues(`project = "${projectKey}" AND labels = "${label}" ORDER BY created ASC`, 1);
    return issues[0]?.key ?? null;
  },
  createIssue(projectKey, summary, dueDate, labels) {
    return createIssue({ projectKey, summary, issueType: 'Story', priority: 'Medium', labels, dueDate });
  },
  async hasBlocksLink(blocker, blocked) {
    return (await listIssueLinks(blocker)).some((link) => isBlocksFrom(link, blocked));
  },
  linkBlocks,
  async moveToSprint(sprintId, issueKeys) {
    await moveIssuesToSprint(Number(sprintId), issueKeys);
  },
  moveToBacklog: moveIssuesToBacklog,
};

export const teamDirectory: TeamDirectory = {
  getTeam: getTeamById,
  async planningContext(team: Team, neededBy) {
    const charter = await getCharter(team.id);
    if (!charter?.valid || !charter.charter) throw new Error(`Team ${team.teamKey} has no valid charter`);
    const [capacity, commitments] = [await teamCapacity(team), await loadCommitments(team, neededBy)];
    return { charter: charter.charter, capacity, sprints: commitments.sprints, commitments: commitments.commitments };
  },
  async approvers(team) {
    const charter = await getCharter(team.id);
    const fromCharter = charter?.charter?.approvers ?? [];
    return [...new Set([...fromCharter, ...(team.leadAccountId ? [team.leadAccountId] : [])])];
  },
  async escalationContact(team, sourceIssueKey) {
    const contact = (await getCharter(team.id))?.charter?.escalationContact;
    const lead = (note?: string) =>
      team.leadAccountId ? { accountId: team.leadAccountId, source: 'project-lead' as const, ...(note ? { note } : {}) } : null;
    if (!contact) return lead();
    // A mention notifies the contact about the source issue, so they must be able to browse its project.
    const projectKey = sourceIssueKey.slice(0, sourceIssueKey.lastIndexOf('-'));
    try {
      const project = await getProject(projectKey);
      const held = await accountProjectPermissions(contact, project.id, ['BROWSE_PROJECTS']);
      if (held.has('BROWSE_PROJECTS')) return { accountId: contact, source: 'charter' };
      return lead(`charter contact cannot browse ${projectKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Accord escalation contact check for ${team.teamKey} on ${projectKey} failed`, message);
      return lead(`charter contact browse check on ${projectKey} failed`);
    }
  },
};

const queuePort: QueuePort = {
  async push(event) {
    await new Queue({ key: NEGOTIATION_QUEUE_KEY }).push([{ body: { ...event } }]);
  },
};

export const productionDeps: NegotiationDeps = {
  store: sqlStore,
  teams: teamDirectory,
  jira: jiraPort,
  queue: queuePort,
  monitor: {
    async evaluateProvider(providerTeamId) {
      const event: MonitorEvent = { type: 'monitor-team', teamId: providerTeamId };
      await new Queue({ key: MONITOR_QUEUE_KEY }).push([{ body: { ...event } }]);
    },
    // monitor/deps imports this module too (renegotiate); monitorDeps is only read at call time.
    workAhead: (providerTeamId, contractId) => providerWorkAhead(monitorDeps, providerTeamId, contractId),
  },
  today: () => new Date().toISOString().slice(0, 10),
  // Only `decide` uses this, and it is only called from resolvers (user context).
  userPermissions: (scope, permissions) => myPermissions(scope, permissions, 'user'),
  allowSameApprover: process.env.ACCORD_DEMO_ALLOW_SAME_APPROVER === 'true',
};
