import { Queue } from '@forge/events';
import { addComment, createIssue, isBlocksFrom, listIssueLinks, linkBlocks, searchIssues } from '../jira/issues';
import { moveIssuesToBacklog, moveIssuesToSprint } from '../jira/sprints';
import { getCharter, getTeamById, type Team } from '../teams/repository';
import { loadCommitments, teamCapacity } from '../teams/service';
import { sqlStore } from './store';
import type { JiraPort, NegotiationDeps, QueuePort, TeamDirectory } from './types';
import { MONITOR_QUEUE_KEY, type MonitorEvent } from '../monitor/monitor';

export const NEGOTIATION_QUEUE_KEY = 'accord-negotiation';

const LABEL = /^[a-z0-9-]{1,100}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

const jiraPort: JiraPort = {
  async addComment(issueKey, text) {
    await addComment(issueKey, text);
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
  },
  today: () => new Date().toISOString().slice(0, 10),
  allowSameApprover: process.env.ACCORD_DEMO_ALLOW_SAME_APPROVER === 'true',
};
