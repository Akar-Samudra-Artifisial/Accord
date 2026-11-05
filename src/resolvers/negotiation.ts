import { randomUUID } from 'node:crypto';
import { getIssue, ISSUE_KEY, visibleIssueKeys } from '../jira/issues';
import { myPermissions } from '../jira/permissions';
import { getCharter, getTeamByKey, getTeamByProjectKey, listTeams, type Team } from '../teams/repository';
import { productionDeps, teamDirectory } from '../negotiation/deps';
import { createRequest, decide, NegotiationError, normalizeTitle, retryRequest, STUCK_AFTER_SECONDS } from '../negotiation/orchestrator';
import {
  approvalsByRequest,
  auditFor,
  contractsForRequests,
  listContracts,
  listEdges,
  optionsByIds,
  recentRequestCount,
  requestsForIssue,
  requestsForTeams,
} from '../negotiation/store';
import { toAuditRow, type AuditRow } from '../negotiation/audit-view';
import { buildDealSheet, redact, summarize } from '../negotiation/views';
import { KIND_LABEL, type Side } from '../negotiation/delegates';
import type { Principal } from '../atlassian/http';
import { formatDateRange } from '../format/dates';
import { explainOption, planOptions, type CostClass, type Size } from '../planner';
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
async function requireViewer(
  request: DependencyRequest,
  sides: readonly Side[],
  deliverable: string | null,
  as: Principal,
): Promise<void> {
  if (sides.length > 0) return;
  const keys = [request.sourceIssueKey, ...(deliverable ? [deliverable] : [])];
  if ((await visibleIssueKeys(keys, as)).size > 0) return;
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
  const requests = [];
  for (const request of found) {
    const contract = await productionDeps.store.getContract(request.id);
    requests.push({
      ...summarize(request, teams, viewerSides(request, approvers, context.accountId), approvals.get(request.id) ?? []),
      contract: contract
        ? { status: contract.status, projectedDate: contract.projectedDate, agreedDateMax: contract.agreedDateMax }
        : null,
    });
  }
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

/**
 * `as` is `user` for every UI and Rovo call; only the development diag web trigger passes `app`
 * (no user context there) together with a fixed creator id.
 */
export async function createRequestFromIssue(payload: Record<string, unknown>, accountId: string | undefined, as: Principal = 'user') {
  if (!accountId) throw new NegotiationError('A signed-in Jira user is required.');
  const sourceIssueKey = readString(payload, 'sourceIssueKey').toUpperCase();
  if (!ISSUE_KEY.test(sourceIssueKey)) throw new NegotiationError('A valid source issue key is required, for example MOB-1.');
  // As the user: the issue must exist, be browsable and accept the user's comments (NFR-3).
  const sourceIssue = await getIssue(sourceIssueKey, as);
  const granted = await myPermissions({ issueKey: sourceIssueKey }, ['BROWSE_PROJECTS', 'ADD_COMMENTS'], as);
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
      title: defaultTitle(readString(payload, 'title'), sourceIssue.fields.summary, sourceIssueKey),
      size: readString(payload, 'size').toUpperCase() as Size,
      minSize: minSize !== null && Number.isNaN(minSize) ? -1 : minSize,
      neededBy: readString(payload, 'neededBy'),
      costClass,
      createdBy: accountId,
    },
    `req-${randomUUID()}`,
  );
  return { requestId: request.id, status: request.status, title: request.title };
}

/**
 * Agents sometimes copy a placeholder from the input description instead of omitting the title,
 * e.g. "(summary of the source issue)". Such text counts as no title.
 */
export function isPlaceholderTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === '' || (trimmed.startsWith('(') && trimmed.endsWith(')')) || /summary of the source issue/i.test(trimmed);
}

/** Request title: the given one, else the source issue summary, else a neutral fallback. */
export function defaultTitle(given: string, summary: string | undefined, sourceIssueKey: string): string {
  const own = isPlaceholderTitle(given) ? '' : normalizeTitle(given);
  return own || normalizeTitle(summary ?? '') || `Work needed for ${sourceIssueKey}`;
}

async function canRetry(request: DependencyRequest, sides: readonly Side[], accountId: string | undefined): Promise<boolean> {
  if (!accountId || (sides.length === 0 && request.createdBy !== accountId)) return false;
  if (request.status === 'failed') return true;
  if (request.status !== 'negotiating' && request.status !== 'approved') return false;
  const idle = await productionDeps.store.lastStepAgeSeconds(request.id);
  return idle === null || idle >= STUCK_AFTER_SECONDS;
}

/** Loads a request the viewer may read (approver/lead of either team, or can browse its issues). */
async function viewableRequest(requestId: unknown, accountId: string | undefined, as: Principal) {
  const request = await productionDeps.store.getRequest(requireRequestId(requestId));
  if (!request) throw new NegotiationError('Request not found.');
  const teams = await teamMap();
  const requester = teams.get(request.requesterTeamId);
  const provider = teams.get(request.providerTeamId);
  if (!requester || !provider) throw new NegotiationError('A team of this request is no longer registered.');
  const sides = viewerSides(request, await approverMap(teams), accountId);
  const contract = await productionDeps.store.getContract(request.id);
  await requireViewer(request, sides, contract?.deliverableIssueKey ?? null, as);
  return { request, requester, provider, sides };
}

export async function dealSheet(payload: Record<string, unknown>, accountId: string | undefined, as: Principal = 'user') {
  const { request, requester, provider, sides } = await viewableRequest(payload.requestId, accountId, as);
  return buildDealSheet({
    store: productionDeps.store,
    request,
    requester,
    provider,
    viewerSides: sides,
    visibleKeys: (keys) => visibleIssueKeys(keys, as),
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

/** Upper bound for the "minimum part earlier" variation (one planning horizon is 12 sprints). */
export const MAX_EARLIER_MIN_DAYS = 60;

/**
 * Runs the planner for a stored request with fresh provider data (same planning context as the
 * negotiation rounds) and optionally one variation. Nothing is stored; restricted issues are redacted.
 */
export async function evaluateRequestOptions(
  requestId: unknown,
  earlierMinDays: number | undefined,
  accountId: string | undefined,
  as: Principal = 'user',
) {
  if (earlierMinDays !== undefined && !(Number.isInteger(earlierMinDays) && earlierMinDays > 0 && earlierMinDays <= MAX_EARLIER_MIN_DAYS)) {
    throw new NegotiationError(`earlierMinDays must be a whole number from 1 to ${MAX_EARLIER_MIN_DAYS}.`);
  }
  const { request, provider } = await viewableRequest(requestId, accountId, as);
  const context = await teamDirectory.planningContext(provider, request.neededBy);
  const result = planOptions({
    request: { size: request.size, minSize: request.minSize ?? undefined, neededBy: request.neededBy, costClass: request.costClass },
    charter: context.charter,
    capacity: context.capacity,
    sprints: context.sprints,
    commitments: context.commitments,
    today: productionDeps.today(),
    variation: earlierMinDays === undefined ? undefined : { kind: 'earlier-min', days: earlierMinDays },
  });
  const shiftedKeys = [...new Set(result.options.flatMap((option) => option.shifted.map((item) => item.key)))];
  const visible = shiftedKeys.length ? await visibleIssueKeys(shiftedKeys, as) : new Set<string>();
  return {
    requestId: request.id,
    provider: provider.name,
    requested: result.requested,
    neededBy: result.neededBy,
    capacity: { pessimistic: result.capacity.pessimistic, realistic: result.capacity.realistic, limitedData: result.capacity.limitedData },
    variation: earlierMinDays === undefined ? null : { kind: 'earlier-min', days: earlierMinDays },
    options: result.options.map((option) => ({
      kind: option.kind,
      dateRange: option.dateRange,
      meetsNeed: option.meetsNeed,
      recommended: option.recommended,
      shiftCost: option.shiftCost,
      rulesUsed: option.rulesUsed,
      shifted: option.shifted.map((item) => ({
        key: visible.has(item.key) ? item.key : 'a restricted issue',
        toSprintId: item.toSprintId,
      })),
      consequences: {
        requester: redact(option.consequences.requester, option.trace, visible),
        provider: redact(option.consequences.provider, option.trace, visible),
      },
      explanation: redact(explainOption(option), option.trace, visible),
    })),
  };
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

export type ContractRole = 'provider' | 'requester';

/** Role of `team` in the contract; without a team filter, the viewer's side (provider first). */
export function contractRole(request: DependencyRequest, team: Team | null, sides: readonly Side[]): ContractRole | null {
  if (team) {
    if (request.providerTeamId === team.id) return 'provider';
    if (request.requesterTeamId === team.id) return 'requester';
    return null;
  }
  if (sides.includes('provider')) return 'provider';
  if (sides.includes('requester')) return 'requester';
  return null;
}

/**
 * Contracts the viewer may see: approver/lead of either team, or able to browse the
 * source issue or the deliverable.
 */
export async function contracts(accountId: string | undefined, teamKey?: string, as: Principal = 'user') {
  if (!accountId) return [];
  const teams = await teamMap();
  const team = teamKey ? await getTeamByKey(teamKey) : null;
  if (teamKey && !team) throw new NegotiationError(`Team ${teamKey} is not registered in Accord.`);
  const approvers = await approverMap(teams);
  const rows = await listContracts(team?.id);
  const needsCheck = rows.filter(({ request }) => viewerSides(request, approvers, accountId).length === 0);
  const keys = needsCheck.flatMap(({ request, contract }) => [request.sourceIssueKey, ...(contract.deliverableIssueKey ? [contract.deliverableIssueKey] : [])]);
  const visible = keys.length ? await visibleIssueKeys(keys, as) : new Set<string>();
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
      // Side of the filtered team (or, without a filter, of the viewer's team); null when the viewer is on neither.
      role: contractRole(request, team, viewerSides(request, approvers, accountId)),
      title: request.title,
      requester: teams.get(request.requesterTeamId)?.name ?? request.requesterTeamId,
      requesterTeamKey: teams.get(request.requesterTeamId)?.teamKey ?? null,
      provider: teams.get(request.providerTeamId)?.name ?? request.providerTeamId,
      providerTeamKey: teams.get(request.providerTeamId)?.teamKey ?? null,
      sourceIssueKey: request.sourceIssueKey,
      deliverableIssueKey: contract.deliverableIssueKey,
      agreedDateMin: contract.agreedDateMin,
      agreedDateMax: contract.agreedDateMax,
      projectedDate: contract.projectedDate,
      status: contract.status,
    }));
}

export interface DependencySummary {
  from: string;
  to: string;
  contracts: number;
  atRisk: number;
}

/** Agreed dependency edges between teams (FR-13), counted over the contracts the viewer may see. */
export async function dependencySummary(visible: ReadonlyArray<{ contractId: number; status: string }>): Promise<DependencySummary[]> {
  if (visible.length === 0) return [];
  const statusById = new Map(visible.map((row) => [row.contractId, row.status]));
  const teams = await teamMap();
  const pairs = new Map<string, DependencySummary>();
  for (const edge of await listEdges()) {
    const status = statusById.get(edge.contractId);
    if (status === undefined) continue;
    const key = `${edge.fromTeamId}>${edge.toTeamId}`;
    const pair = pairs.get(key) ?? {
      from: teams.get(edge.fromTeamId)?.name ?? edge.fromTeamId,
      to: teams.get(edge.toTeamId)?.name ?? edge.toTeamId,
      contracts: 0,
      atRisk: 0,
    };
    pairs.set(key, { ...pair, contracts: pair.contracts + 1, atRisk: pair.atRisk + (status === 'at-risk' ? 1 : 0) });
  }
  return [...pairs.values()].sort((a, b) => b.atRisk - a.atRisk || b.contracts - a.contracts);
}

const ALL_STATUSES = ['negotiating', 'awaiting-approval', 'approved', 'contracted', 'rejected', 'failed'] as const;

/**
 * Recent audit entries (NFR-7) of requests and contracts of teams the viewer can access: teams where
 * they are an approver/lead, or whose Jira project they can browse (checked as the user).
 */
const approvedOptionId = (payload: unknown): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>).optionId : undefined;

export async function auditTrail(accountId: string | undefined): Promise<AuditRow[]> {
  if (!accountId) return [];
  const teams = await teamMap();
  const approvers = await approverMap(teams);
  // Approver teams need no Jira call; the remaining project checks run in parallel (one call per project).
  const visible = await Promise.all(
    [...teams.values()].map(async (team) => {
      if (approvers.get(team.id)?.includes(accountId)) return team.id;
      const granted = await myPermissions({ projectKey: team.jiraProjectKey }, ['BROWSE_PROJECTS']);
      return granted.has('BROWSE_PROJECTS') ? team.id : null;
    }),
  );
  const teamIds = visible.filter((id): id is string => id !== null);
  const requests = await requestsForTeams(teamIds, ALL_STATUSES, 100);
  const titles = new Map(requests.map((request) => [request.id, request.title]));
  const contractTitles = new Map<string, string>();
  for (const { contract, request } of await contractsForRequests([...titles.keys()])) {
    contractTitles.set(String(contract.id), request.title);
  }
  const entries = await auditFor([...titles.keys()], [...contractTitles.keys()].map(Number), 50);
  const approvedIds = entries.filter((entry) => entry.action === 'approved').map((entry) => Number(approvedOptionId(entry.payload)));
  const options = await optionsByIds(approvedIds);
  const approverIds = new Set([...approvers.values()].flat());
  return entries.map((entry) =>
    toAuditRow(entry, {
      viewerAccountId: accountId,
      approverIds,
      subjectOf: (item) =>
        (item.entityType === 'contract' ? contractTitles.get(item.entityId) : titles.get(item.entityId)) ?? 'Unknown request',
      optionLabel: (optionId) => {
        const option = options.get(optionId);
        if (!option) return null;
        const range = option.dateRange.min ? `, ${formatDateRange(option.dateRange.min, option.dateRange.max)}` : '';
        return `"${KIND_LABEL[option.kind]}"${range}`;
      },
    }),
  );
}
