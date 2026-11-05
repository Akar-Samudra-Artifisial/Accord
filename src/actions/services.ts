import { UserFacingError } from '../errors';
import { describeRule } from '../planner';
import { getCharter, getTeamByKey, listTeams } from '../teams/repository';
import { loadCommitments, teamCapacity } from '../teams/service';
import { teamDirectory } from '../negotiation/deps';
import { contracts, createRequestFromIssue, dealSheet, evaluateRequestOptions, previewRequestFromIssue } from '../resolvers/negotiation';
import { myPermissions } from '../jira/permissions';
import { route } from '@forge/api';
import { jira } from '../atlassian/http';
import { ISSUE_KEY } from '../jira/issues';
import { hasTeamAccess, type TeamAccessChecks } from './access';
import { contractLinks, parseBaseUrl, requestLinks, siteLinks, type SiteLinks } from './links';
import type { ActionServices, Viewer } from './handlers';
import { contractDirection, contractDisplay, neededByDates, optionDates, rangeDisplay, sprintDates } from './display';

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

/**
 * The viewer's own teams, for the direction of a contract: teams they approve for (or lead); a viewer who
 * approves for none counts the teams whose project they can browse (fail closed per team).
 */
async function viewerTeamKeys(viewer: Viewer): Promise<Set<string>> {
  const all = await listTeams();
  const approves = await Promise.all(all.map(async (team) => (await teamDirectory.approvers(team)).includes(viewer.accountId ?? '')));
  const approved = all.filter((_, index) => approves[index]);
  if (approved.length) return new Set(approved.map((team) => team.teamKey));
  const browse = await Promise.all(all.map((team) => accessChecks.canBrowseProject(team.jiraProjectKey, viewer).catch(() => false)));
  return new Set(all.filter((_, index) => browse[index]).map((team) => team.teamKey));
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
  // Every registered team, like the Teams tab; `access` says whether the viewer may see more than the
  // aggregate capacity (approver/lead or Browse on the team project, checked as the user).
  async teams(viewer) {
    requireSignedIn(viewer);
    const all = await listTeams();
    const access = await Promise.all(all.map((team) => hasTeamAccess(team, viewer, accessChecks)));
    return all.map(({ teamKey, name, jiraProjectKey }, index) => ({
      teamKey,
      name,
      jiraProjectKey,
      access: access[index] ? ('full' as const) : ('restricted' as const),
    }));
  },

  async teamCharter(teamKey, viewer) {
    requireSignedIn(viewer);
    const team = await getTeamByKey(teamKey);
    if (!team) throw new UserFacingError(`Team ${teamKey} is not registered in Accord.`);
    const stored = await getCharter(team.id);
    const charterStatus = !team.charterPageId ? 'none' : stored?.valid ? 'valid' : 'invalid';
    if (!(await hasTeamAccess(team, viewer, accessChecks))) {
      // Like the Teams tab: whether a charter exists, never its content.
      return {
        teamKey: team.teamKey,
        team: team.name,
        access: 'restricted' as const,
        charterStatus,
        note: `${team.name} exists, but you do not have access to its Jira project, so its charter is not shared.`,
      };
    }
    const charter = stored?.charter ?? null;
    return {
      teamKey: team.teamKey,
      team: team.name,
      access: 'full' as const,
      charterStatus,
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
    requireSignedIn(viewer);
    const found = await getTeamByKey(teamKey);
    if (!found) throw new UserFacingError(`Team ${teamKey} is not registered in Accord.`);
    if (!(await hasTeamAccess(found, viewer, accessChecks))) {
      // Exactly what the Teams tab shows every signed-in user: name and aggregate capacity, no sprints or issues.
      const capacity = await teamCapacity(found);
      return {
        teamKey: found.teamKey,
        team: found.name,
        access: 'restricted' as const,
        note: `${found.name} exists, but you do not have access to its Jira project, so only its aggregate capacity is shared.`,
        source: capacity.sourceLabel,
        limitedData: capacity.limitedData,
        pessimisticPerSprint: capacity.pessimistic,
        realisticPerSprint: capacity.realistic,
        samples: capacity.samples,
      };
    }
    const team = found;
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
      access: 'full' as const,
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
          ...sprintDates(sprint.startDate, sprint.endDate),
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
      ...neededByDates(sheet.request.neededBy),
      costClass: sheet.request.costClass,
      requester: sheet.requester.name,
      provider: sheet.provider.name,
      rounds: sheet.rounds,
      transcript: sheet.transcript,
      options: sheet.options.map(({ id, label, dateRange, meetsNeed, recommended, consequences, rulesUsed, explanation }) => ({
        id,
        label,
        ...optionDates(dateRange),
        meetsNeed,
        recommended,
        consequences,
        rulesUsed,
        explanation,
      })),
      agreedOptionId: sheet.agreedOptionId,
      contract: sheet.contract
        ? {
            ...contractDisplay(sheet.contract),
            ...contractLinks(site, { sourceIssueKey: sheet.request.sourceIssueKey, deliverableIssueKey: sheet.contract.deliverableIssueKey }),
            // Past-tense Jira changes; says "Linked existing" when a renegotiation kept the deliverable.
            jiraChanges: sheet.appliedChanges.map((change) => change.text),
          }
        : null,
    };
  },

  async evaluateOptions(requestId, earlierMinDays, viewer) {
    const { neededBy, ...result } = await evaluateRequestOptions(requestId, earlierMinDays, viewer.accountId, viewer.as);
    const site = await links();
    return {
      ...result,
      ...neededByDates(neededBy),
      options: result.options.map(({ dateRange, ...option }) => ({
        ...option,
        ...optionDates(dateRange),
        // Restricted issues keep their placeholder and get no link.
        shifted: option.shifted.map((item) => ({ ...item, url: ISSUE_KEY.test(item.key) ? site.issue(item.key) : null })),
      })),
    };
  },

  async contracts(teamKey, viewer) {
    const site = await links();
    const rows = await contracts(viewer.accountId, teamKey, viewer.as);
    const own = rows.length ? await viewerTeamKeys(viewer) : new Set<string>();
    return {
      teamKey: teamKey ?? null,
      contracts: rows.map(({ supersededBy, ...row }) => ({
        ...contractDisplay(row),
        ...contractLinks(site, row),
        // Viewer-perspective direction (additive): agents use it for "what do we owe" / "what do others deliver to us".
        ...contractDirection(row, own),
        // FR-14: the renegotiated contract that replaced this one, with display dates only.
        supersededBy: supersededBy
          ? {
              requestId: supersededBy.requestId,
              contractId: supersededBy.contractId,
              agreedDisplay: rangeDisplay(supersededBy.agreedDateMin, supersededBy.agreedDateMax, 'No date agreed'),
            }
          : null,
      })),
    };
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

  async previewRequest(input, viewer) {
    const { neededBy, ...preview } = await previewRequestFromIssue({ ...input }, viewer.accountId, viewer.as);
    return {
      preview: true,
      created: false,
      ...preview,
      ...neededByDates(neededBy),
      ...requestLinks(await links(), preview.sourceIssueKey),
      note: 'Nothing was created. Show these values to the user; call again with confirm=true only after the user explicitly agrees.',
    };
  },
};
