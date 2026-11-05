import { UserFacingError } from '../errors';
import { describeRule } from '../planner';
import { getCharter, getTeamByKey, listTeams, type Team } from '../teams/repository';
import { loadCommitments, teamCapacity } from '../teams/service';
import { teamDirectory } from '../negotiation/deps';
import { contracts, createRequestFromIssue, dealSheet, evaluateRequestOptions } from '../resolvers/negotiation';
import { myPermissions } from '../jira/permissions';
import { route } from '@forge/api';
import { jira } from '../atlassian/http';
import { ISSUE_KEY } from '../jira/issues';
import { requireTeamAccess, type TeamAccessChecks } from './access';
import { contractLinks, parseBaseUrl, requestLinks, siteLinks, type SiteLinks } from './links';
import type { ActionServices, Viewer } from './handlers';

/** Production services for the Rovo actions: Forge SQL, Jira and Confluence data only (no demo data). */

function requireSignedIn(viewer: Viewer): void {
  if (!viewer.accountId) throw new UserFacingError('A signed-in Jira user is required.');
}

const accessChecks: TeamAccessChecks = {
  approvers: (team) => teamDirectory.approvers(team),
  async canBrowseProject(projectKey, viewer) {
    return (await myPermissions({ projectKey }, ['BROWSE_PROJECTS'], viewer.as)).has('BROWSE_PROJECTS');
  },
};

/** Registered team the viewer may see (approver/lead or BROWSE_PROJECTS on the team project). */
async function requireTeam(teamKey: string, viewer: Viewer): Promise<Team> {
  requireSignedIn(viewer);
  const team = await getTeamByKey(teamKey);
  if (!team) throw new UserFacingError(`Team ${teamKey} is not registered in Accord.`);
  await requireTeamAccess(team, viewer, accessChecks);
  return team;
}

let baseUrl: Promise<string> | null = null;

/** Site links from Jira serverInfo `baseUrl` (cached per runtime; a failed lookup is retried next time). */
export async function links(): Promise<SiteLinks> {
  baseUrl ??= jira<{ baseUrl?: unknown }>(route`/rest/api/3/serverInfo`).then((info) => parseBaseUrl(info.baseUrl));
  try {
    return siteLinks(await baseUrl);
  } catch (error) {
    baseUrl = null;
    throw error;
  }
}

export const actionServices: ActionServices = {
  // Keys and names only (no leads, approvers or charter content), so agents can map names to keys.
  async teams() {
    return (await listTeams()).map(({ teamKey, name, jiraProjectKey }) => ({ teamKey, name, jiraProjectKey }));
  },

  async teamCharter(teamKey, viewer) {
    const team = await requireTeam(teamKey, viewer);
    const stored = await getCharter(team.id);
    const charter = stored?.charter ?? null;
    return {
      teamKey: team.teamKey,
      team: team.name,
      charterStatus: !team.charterPageId ? 'none' : stored?.valid ? 'valid' : 'invalid',
      missingFields: stored?.missingFields ?? [],
      priorities: charter?.priorities ?? [],
      redLines: (charter?.redLines ?? []).map(describeRule),
      shiftable: (charter?.shiftable ?? []).map(describeRule),
      maxExternalShare: charter?.maxExternalShare ?? null,
      responseDays: charter?.responseDays ?? null,
      // Counts only: account ids of approvers are not exposed to the agent.
      approverCount: (await teamDirectory.approvers(team)).length,
      charterVersion: stored?.pageVersion ?? null,
      charterUrl: team.charterPageId ? (await links()).page(team.charterPageId) : null,
    };
  },

  async teamCapacity(teamKey, viewer) {
    const team = await requireTeam(teamKey, viewer);
    const [capacity, planning, stored] = [await teamCapacity(team), await loadCommitments(team), await getCharter(team.id)];
    const share = stored?.charter?.maxExternalShare ?? null;
    const committed = new Map<string, number>();
    for (const item of planning.commitments) {
      if (item.sprintId) committed.set(item.sprintId, (committed.get(item.sprintId) ?? 0) + (item.size ?? 1));
    }
    const sprintIds = new Set(committed.keys());
    return {
      teamKey: team.teamKey,
      team: team.name,
      source: capacity.sourceLabel,
      limitedData: capacity.limitedData,
      pessimisticPerSprint: capacity.pessimistic,
      realisticPerSprint: capacity.realistic,
      samples: capacity.samples,
      maxExternalShare: share,
      externalCapPerSprint: share === null ? null : Math.max(0, Math.floor(share * capacity.pessimistic)),
      sprints: planning.sprints
        .filter((sprint) => sprintIds.has(sprint.id) || sprint.state === 'active')
        .map((sprint) => ({
          name: sprint.name,
          state: sprint.state,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          openCommittedIssues: committed.get(sprint.id) ?? 0,
        })),
    };
  },

  async request(requestId, viewer) {
    const sheet = await dealSheet({ requestId }, viewer.accountId, viewer.as);
    const site = await links();
    return {
      requestId,
      sourceIssueKey: sheet.request.sourceIssueKey,
      ...requestLinks(site, sheet.request.sourceIssueKey),
      status: sheet.request.status,
      title: sheet.request.title,
      size: sheet.request.size,
      minSize: sheet.request.minSize,
      neededBy: sheet.request.neededBy,
      costClass: sheet.request.costClass,
      requester: sheet.requester.name,
      provider: sheet.provider.name,
      rounds: sheet.rounds,
      transcript: sheet.transcript,
      options: sheet.options.map(({ id, label, dateRange, meetsNeed, recommended, consequences, rulesUsed, explanation }) => ({
        id,
        label,
        dateRange,
        meetsNeed,
        recommended,
        consequences,
        rulesUsed,
        explanation,
      })),
      agreedOptionId: sheet.agreedOptionId,
      contract: sheet.contract
        ? {
            ...sheet.contract,
            ...contractLinks(site, { sourceIssueKey: sheet.request.sourceIssueKey, deliverableIssueKey: sheet.contract.deliverableIssueKey }),
          }
        : null,
    };
  },

  async evaluateOptions(requestId, earlierMinDays, viewer) {
    const result = await evaluateRequestOptions(requestId, earlierMinDays, viewer.accountId, viewer.as);
    const site = await links();
    return {
      ...result,
      options: result.options.map((option) => ({
        ...option,
        // Restricted issues keep their placeholder and get no link.
        shifted: option.shifted.map((item) => ({ ...item, url: ISSUE_KEY.test(item.key) ? site.issue(item.key) : null })),
      })),
    };
  },

  async contracts(teamKey, viewer) {
    const site = await links();
    const rows = await contracts(viewer.accountId, teamKey, viewer.as);
    return { teamKey: teamKey ?? null, contracts: rows.map((row) => ({ ...row, ...contractLinks(site, row) })) };
  },

  async createRequest(input, viewer) {
    const created = await createRequestFromIssue({ ...input }, viewer.accountId, viewer.as);
    return {
      ...created,
      sourceIssueKey: input.sourceIssueKey,
      ...requestLinks(await links(), input.sourceIssueKey),
      note: 'Negotiation started. Both team leads decide in the Accord deal sheet on the source issue (url); agents cannot approve.',
    };
  },
};
