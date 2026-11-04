import { randomUUID } from 'node:crypto';
import { getIssue, ISSUE_KEY, visibleIssueKeys } from '../jira/issues';
import { myPermissions } from '../jira/permissions';
import { getCharter, getTeamByKey, getTeamByProjectKey, listTeams, type Team } from '../teams/repository';
import { productionDeps, teamDirectory } from '../negotiation/deps';
import { createRequest, decide, NegotiationError, retryRequest, STUCK_AFTER_SECONDS } from '../negotiation/orchestrator';
import { approvalsByRequest, listContracts, recentRequestCount, requestsForIssue, requestsForTeams } from '../negotiation/store';
import { buildDealSheet, summarize, type RequestSummary } from '../negotiation/views';
import type { Side } from '../negotiation/delegates';
import type { CostClass, Size } from '../planner';
import type { DependencyRequest } from '../negotiation/types';

/** Resolver logic for the issue panel, deal sheet and global page (M3). */

export interface ResolverContext {
  accountId?: string;
  extension?: { issue?: { key?: string }; project?: { key?: string } };
}

const REQUEST_ID = /^req-[0-9a-f-]{36}$/;
/** Simple per-user rate limit for new requests, counted in SQL. */
export const MAX_REQUESTS_PER_HOUR = 10;

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new NegotiationError('A valid request id is required.');
  return value;
}

async function teamMap(): Promise<Map<string, Team>> {
  return new Map((await listTeams()).map((team) => [team.id, team]));
}

/** Approver account ids per team id, loaded once per call (charter approvers + project lead). */
async function approverMap(teams: ReadonlyMap<string, Team>): Promise<Map<string, string[]>> {
  const entries = await Promise.all([...teams.values()].map(async (team) => [team.id, await teamDirectory.approvers(team)] as const));
  return new Map(entries);
}

/** Sides the account may decide for: charter approvers or project lead of each team. */
export function viewerSides(request: DependencyRequest, approvers: ReadonlyMap<string, string[]>, accountId?: string): Side[] {
  if (!accountId) return [];
  const sides: Side[] = [];
  if (approvers.get(request.requesterTeamId)?.includes(accountId)) sides.push('requester');
  if (approvers.get(request.providerTeamId)?.includes(accountId)) sides.push('provider');
  return sides;
}

/**
 * Read access to a request: approvers/leads of either team, or users who can browse the
 * source issue or the deliverable (checked as the user).
 */
async function requireViewer(request: DependencyRequest, sides: readonly Side[], deliverable: string | null): Promise<void> {
  if (sides.length > 0) return;
  const keys = [request.sourceIssueKey, ...(deliverable ? [deliverable] : [])];
  if ((await visibleIssueKeys(keys, 'user')).size > 0) return;
  throw new NegotiationError('You do not have access to this request.');
}

function projectKeyOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf('-'));
}

export async function panelState(context: ResolverContext) {
  const issueKey = context.extension?.issue?.key;
  if (!issueKey || !ISSUE_KEY.test(issueKey)) throw new NegotiationError('No Jira issue in context.');
  const teams = await teamMap();
  const requesterTeam = await getTeamByProjectKey(projectKeyOf(issueKey));
  const providerTeams = [];
  for (const team of teams.values()) {
    if (team.id === requesterTeam?.id) continue;
    if ((await getCharter(team.id))?.valid) providerTeams.push({ teamKey: team.teamKey, name: team.name });
  }
  const found = await requestsForIssue(issueKey);
  const [approvers, approvals] = await Promise.all([approverMap(teams), approvalsByRequest(found.map((r) => r.id))]);
  const requests: RequestSummary[] = found.map((request) =>
    summarize(request, teams, viewerSides(request, approvers, context.accountId), approvals.get(request.id) ?? []),
  );
  return {
    issueKey,
    requesterTeam: requesterTeam ? { teamKey: requesterTeam.teamKey, name: requesterTeam.name } : null,
    providerTeams,
    requests,
  };
}

function readString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  return typeof value === 'string' ? value.trim() : '';
}

export async function createRequestFromIssue(payload: Record<string, unknown>, accountId: string | undefined) {
  if (!accountId) throw new NegotiationError('A signed-in Jira user is required.');
  const sourceIssueKey = readString(payload, 'sourceIssueKey').toUpperCase();
  if (!ISSUE_KEY.test(sourceIssueKey)) throw new NegotiationError('A valid source issue key is required, for example MOB-1.');
  // As the user: the issue must exist, be browsable and accept the user's comments (NFR-3).
  await getIssue(sourceIssueKey, 'user');
  const granted = await myPermissions({ issueKey: sourceIssueKey }, ['BROWSE_PROJECTS', 'ADD_COMMENTS']);
  if (!granted.has('BROWSE_PROJECTS') || !granted.has('ADD_COMMENTS')) {
    throw new NegotiationError(`You need permission to browse and comment on ${sourceIssueKey} to request work for it.`);
  }
  // The requester team is the team of the source issue's project; the user is a member through that project.
  const requesterTeam = await getTeamByProjectKey(projectKeyOf(sourceIssueKey));
  if (!requesterTeam) throw new NegotiationError(`Project ${projectKeyOf(sourceIssueKey)} is not an Accord team yet. Add it in Accord → Teams.`);
  const providerTeam = await getTeamByKey(readString(payload, 'providerTeamKey').toUpperCase());
  if (!providerTeam) throw new NegotiationError('Choose a registered provider team.');
  if (!(await getCharter(providerTeam.id))?.valid) {
    throw new NegotiationError(`${providerTeam.name} has no valid charter, so it cannot receive requests yet.`);
  }
  if ((await recentRequestCount(accountId)) >= MAX_REQUESTS_PER_HOUR) {
    throw new NegotiationError(`You can create at most ${MAX_REQUESTS_PER_HOUR} requests per hour. Try again later.`);
  }
  const rawMin = payload.minSize;
  const minSize = rawMin === undefined || rawMin === null || rawMin === '' ? null : Number(rawMin);
  const costClass = (readString(payload, 'costClass') || 'standard') as CostClass;
  const request = await createRequest(
    productionDeps,
    {
      sourceIssueKey,
      requesterTeam,
      providerTeam,
      title: readString(payload, 'title'),
      size: readString(payload, 'size').toUpperCase() as Size,
      minSize: minSize !== null && Number.isNaN(minSize) ? -1 : minSize,
      neededBy: readString(payload, 'neededBy'),
      costClass,
      createdBy: accountId,
    },
    `req-${randomUUID()}`,
  );
  return { requestId: request.id, status: request.status };
}

async function canRetry(request: DependencyRequest, sides: readonly Side[], accountId: string | undefined): Promise<boolean> {
  if (!accountId || (sides.length === 0 && request.createdBy !== accountId)) return false;
  if (request.status === 'failed') return true;
  if (request.status !== 'negotiating' && request.status !== 'approved') return false;
  const idle = await productionDeps.store.lastStepAgeSeconds(request.id);
  return idle === null || idle >= STUCK_AFTER_SECONDS;
}

export async function dealSheet(payload: Record<string, unknown>, accountId: string | undefined) {
  const request = await productionDeps.store.getRequest(requireRequestId(payload.requestId));
  if (!request) throw new NegotiationError('Request not found.');
  const teams = await teamMap();
  const requester = teams.get(request.requesterTeamId);
  const provider = teams.get(request.providerTeamId);
  if (!requester || !provider) throw new NegotiationError('A team of this request is no longer registered.');
  const sides = viewerSides(request, await approverMap(teams), accountId);
  const contract = await productionDeps.store.getContract(request.id);
  await requireViewer(request, sides, contract?.deliverableIssueKey ?? null);
  return buildDealSheet({
    store: productionDeps.store,
    request,
    requester,
    provider,
    viewerSides: sides,
    visibleKeys: (keys) => visibleIssueKeys(keys, 'user'),
    sameApproverAllowed: productionDeps.allowSameApprover,
    canRetry: await canRetry(request, sides, accountId),
    viewerAccountId: accountId,
  });
}

export async function decideOnDealSheet(payload: Record<string, unknown>, accountId: string | undefined) {
  const side = payload.side;
  const decision = payload.decision;
  if (side !== 'requester' && side !== 'provider') throw new NegotiationError('Side must be requester or provider.');
  if (decision !== 'approve' && decision !== 'reject') throw new NegotiationError('Decision must be approve or reject.');
  const optionId = Number(payload.optionId);
  if (!Number.isInteger(optionId) || optionId <= 0) throw new NegotiationError('A valid option id is required.');
  return decide(productionDeps, {
    requestId: requireRequestId(payload.requestId),
    optionId,
    side,
    decision,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    // Identity always comes from the Forge invocation context, never from the payload.
    accountId,
  });
}

export async function retryStalledRequest(payload: Record<string, unknown>, accountId: string | undefined) {
  return retryRequest(productionDeps, requireRequestId(payload.requestId), accountId);
}

/** Requests the viewer is involved in as an approver: awaiting a decision first. */
export async function inbox(accountId: string | undefined) {
  if (!accountId) return [];
  const teams = await teamMap();
  const approvers = await approverMap(teams);
  const myTeams = [...approvers].filter(([, ids]) => ids.includes(accountId)).map(([teamId]) => teamId);
  // Viewer filter in SQL, before the limit.
  const found = await requestsForTeams(myTeams, ['awaiting-approval', 'negotiating', 'approved', 'failed', 'rejected'], 50);
  const approvals = await approvalsByRequest(found.map((request) => request.id));
  return found
    .map((request) => summarize(request, teams, viewerSides(request, approvers, accountId), approvals.get(request.id) ?? []))
    .sort((a, b) => b.pendingFor.length - a.pendingFor.length);
}

/**
 * Contracts the viewer may see: approver/lead of either team, or able to browse the
 * source issue or the deliverable.
 */
export async function contracts(accountId: string | undefined, teamKey?: string) {
  if (!accountId) return [];
  const teams = await teamMap();
  const team = teamKey ? await getTeamByKey(teamKey) : null;
  if (teamKey && !team) throw new NegotiationError(`Team ${teamKey} is not registered in Accord.`);
  const approvers = await approverMap(teams);
  const rows = await listContracts(team?.id);
  const needsCheck = rows.filter(({ request }) => viewerSides(request, approvers, accountId).length === 0);
  const keys = needsCheck.flatMap(({ request, contract }) => [request.sourceIssueKey, ...(contract.deliverableIssueKey ? [contract.deliverableIssueKey] : [])]);
  const visible = keys.length ? await visibleIssueKeys(keys, 'user') : new Set<string>();
  return rows
    .filter(
      ({ request, contract }) =>
        viewerSides(request, approvers, accountId).length > 0 ||
        visible.has(request.sourceIssueKey) ||
        (contract.deliverableIssueKey !== null && visible.has(contract.deliverableIssueKey)),
    )
    .map(({ contract, request }) => ({
      contractId: contract.id,
      requestId: request.id,
      title: request.title,
      requester: teams.get(request.requesterTeamId)?.name ?? request.requesterTeamId,
      provider: teams.get(request.providerTeamId)?.name ?? request.providerTeamId,
      sourceIssueKey: request.sourceIssueKey,
      deliverableIssueKey: contract.deliverableIssueKey,
      agreedDateMin: contract.agreedDateMin,
      agreedDateMax: contract.agreedDateMax,
      projectedDate: contract.projectedDate,
      status: contract.status,
    }));
}
