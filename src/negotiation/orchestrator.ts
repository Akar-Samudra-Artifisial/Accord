import { planOptions, isValidIsoDate, deliverableSprintOf, type CostClass, type PlannerInput, type PlannerOption, type PlannerVariation, type Size } from '../planner';
import { UserFacingError } from '../errors';
import type { JiraPermission } from '../jira/permissions';
import { formatDate, formatDateRange } from '../format/dates';
import { plural } from '../format/text';
import type { Team } from '../teams/repository';
import {
  approvalState,
  isProjectedSprint,
  KIND_LABEL,
  rankOptions,
  requesterDecision,
  type RequesterDecision,
  type Side,
} from './delegates';
import { APP_CREATOR, LINK_CREATED_STEP } from './types';
import type {
  Contract,
  DependencyRequest,
  NegotiationDeps,
  PlanningContext,
  RenegotiationWorkAhead,
  RequestStatus,
  StoredOption,
} from './types';
import type { IsoDate } from '../planner';

/**
 * Negotiation orchestration (FR-8..FR-10). Each round runs as its own queue job
 * and checks the stored round status first, so platform retries are safe (NFR-5).
 * Agents never approve: only `decide` (called with the Forge user context) records
 * approvals (NFR-2).
 */

/** Why `createRequest` stored nothing (or stored a failed request), for callers that react differently. */
export type CreateFailure = 'exists' | 'duplicate' | 'provider-limit' | 'enqueue-failed';

export class NegotiationError extends UserFacingError {
  constructor(
    message: string,
    readonly code?: CreateFailure,
  ) {
    super(message);
    this.name = 'NegotiationError';
  }
}

const APP_ACTOR_REASON = 'Queue job without a user context; runs as the app after both team leads approved.';

/**
 * After a deliverable-create attempt whose result was lost (crash, timeout), wait this long for
 * Jira search to index the labelled issue before creating it again.
 */
export const DELIVERABLE_SEARCH_GRACE_SECONDS = 20;
const DELIVERABLE_INTENT = 'contract:deliverable-intent';

/** A request in `negotiating`/`approved` without activity for this long may be re-queued by a lead. */
export const STUCK_AFTER_SECONDS = 5 * 60;

function toStoredDraft(option: PlannerOption): Omit<StoredOption, 'id' | 'requestId' | 'roundId'> {
  return {
    kind: option.kind,
    dateRange: option.dateRange,
    shifted: option.shifted,
    rulesUsed: option.rulesUsed,
    trace: option.trace,
    meetsNeed: option.meetsNeed,
    shiftCost: option.shiftCost,
    recommended: false,
  };
}

async function requireRequest(deps: NegotiationDeps, requestId: string): Promise<DependencyRequest> {
  const request = await deps.store.getRequest(requestId);
  if (!request) throw new NegotiationError(`Request ${requestId} not found`);
  return request;
}

async function requireTeam(deps: NegotiationDeps, teamId: string): Promise<Team> {
  const team = await deps.teams.getTeam(teamId);
  if (!team) throw new NegotiationError(`Team ${teamId} not found`);
  return team;
}

function plannerInput(
  deps: NegotiationDeps,
  request: DependencyRequest,
  context: PlanningContext,
  variation?: PlannerVariation,
): PlannerInput {
  return {
    request: {
      size: request.size,
      minSize: request.minSize ?? undefined,
      neededBy: request.neededBy,
      costClass: request.costClass,
    },
    charter: context.charter,
    capacity: context.capacity,
    sprints: context.sprints,
    commitments: context.commitments,
    today: deps.today(),
    variation,
  };
}

/** Aggregate numbers only: round input never stores issue details (NFR-3). */
function inputSummary(input: PlannerInput) {
  return {
    today: input.today,
    capacity: { pessimistic: input.capacity.pessimistic, realistic: input.capacity.realistic, samples: input.capacity.samples },
    maxExternalShare: input.charter.maxExternalShare,
    sprintIds: input.sprints.map((sprint) => sprint.id),
    commitmentCount: input.commitments.length,
    variation: input.variation ?? null,
  };
}

async function runRound<T>(
  deps: NegotiationDeps,
  requestId: string,
  roundNo: 1 | 2,
  role: 'provider-delegate' | 'requester-delegate' | 'broker',
  input: unknown,
  work: (roundId: number) => Promise<T>,
): Promise<T> {
  const roundId = await deps.store.startRound(requestId, roundNo, role, input);
  try {
    const output = await work(roundId);
    await deps.store.finishRound(roundId, output);
    return output;
  } catch (error) {
    await deps.store.failRound(roundId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export type RoundResult = { status: 'done' | 'skipped'; detail: string };

/** Round 1: provider delegate offers planner options, requester delegate may ask for one variation. */
export async function runRound1(deps: NegotiationDeps, requestId: string): Promise<RoundResult> {
  const request = await requireRequest(deps, requestId);
  if (request.status !== 'negotiating') return { status: 'skipped', detail: `request is ${request.status}` };
  const provider = await requireTeam(deps, request.providerTeamId);
  // A renegotiation re-plans the deliverable of the contract at risk: it is neither work ahead of itself
  // nor a candidate to shift, so it leaves the provider commitments.
  const renegotiation = await deps.store.getRenegotiation(requestId);
  const replanned = renegotiation ? ((await deps.store.getContract(renegotiation.parentRequestId))?.deliverableIssueKey ?? null) : null;
  // Jira/SQL planning data is loaded at most once per job and shared by both delegates.
  let planning: Promise<PlanningContext> | null = null;
  const context = () =>
    (planning ??= deps.teams
      .planningContext(provider, request.neededBy)
      .then((loaded) => (replanned ? { ...loaded, commitments: loaded.commitments.filter((item) => item.key !== replanned) } : loaded)));
  // Every request plans with the monitor's projection (NFR-1): its options are never dates the monitor
  // already projects as missed, so an applied contract is on track on the same data. The other open
  // contracts are ahead only when agreed by the option's date (monitor order); later ones must stay on track.
  let ahead: Promise<RenegotiationWorkAhead | null> | null = null;
  const workAhead = () => (ahead ??= deps.monitor.workAhead(provider.id, renegotiation ? renegotiation.contractId : null));
  const input = async (variation?: PlannerVariation) => {
    const found = await workAhead();
    const base = plannerInput(deps, request, await context(), variation);
    return found
      ? {
          ...base,
          workAhead: {
            issues: found.issues,
            countedKeys: found.countedKeys,
            countedSprintIds: found.countedSprintIds,
            pinnedKeys: found.pinnedKeys,
            contracts: found.contracts,
          },
        }
      : base;
  };
  // Only a renegotiation's deal sheet explains the work ahead (critical bugs, FR-14).
  const aheadSummary = async () => {
    const found = renegotiation ? await workAhead() : null;
    if (!found) return {};
    const { issues, committedIssues, contractIssues, criticalBugs, pessimistic } = found;
    return { workAhead: { issues, committedIssues, contractIssues, criticalBugs, pessimistic } };
  };

  const providerRound = await deps.store.getRound(requestId, 1, 'provider-delegate');
  let offers: StoredOption[];
  if (providerRound?.status === 'done') {
    offers = (await deps.store.listOptions(requestId)).filter((option) => option.roundId === providerRound.id);
  } else {
    let stored: StoredOption[] = [];
    await runRound(deps, requestId, 1, 'provider-delegate', { neededBy: request.neededBy }, async (roundId) => {
      const planned = await input();
      stored = await deps.store.replaceOptions(requestId, roundId, planOptions(planned).options.map(toStoredDraft));
      return { planner: inputSummary(planned), ...(await aheadSummary()), optionIds: stored.map((option) => option.id) };
    });
    offers = stored;
    await deps.store.audit('request', requestId, 'options-proposed', null, {
      round: 1,
      optionIds: offers.map((option) => option.id),
      kinds: offers.map((option) => option.kind),
    });
  }

  const requesterRound = await deps.store.getRound(requestId, 1, 'requester-delegate');
  if (requesterRound?.status !== 'done') {
    const decision = requesterDecision(request, offers);
    await runRound(deps, requestId, 1, 'requester-delegate', { offerIds: offers.map((o) => o.id) }, async (roundId) => {
      if (decision.action === 'request-variation') {
        const result = planOptions(await input(decision.variation));
        const stored = await deps.store.replaceOptions(requestId, roundId, result.options.map(toStoredDraft));
        return { decision, variationOptionIds: stored.map((option) => option.id) };
      }
      return { decision, variationOptionIds: [] as number[] };
    });
  }
  await deps.queue.push({ type: 'round2', requestId });
  return { status: 'done', detail: plural(offers.length, 'offer') };
}

interface BrokerOutput {
  rankedOptionIds: number[];
  recommendedOptionId: number;
}

/** Round 2: broker ranks all options, marks one recommendation and opens the deal sheet. */
export async function runRound2(deps: NegotiationDeps, requestId: string): Promise<RoundResult> {
  const request = await requireRequest(deps, requestId);
  if (request.status !== 'negotiating') return { status: 'skipped', detail: `request is ${request.status}` };
  const brokerRound = await deps.store.getRound(requestId, 2, 'broker');

  let output: BrokerOutput;
  if (brokerRound?.status === 'done') {
    // Resume: the broker finished but the status change was lost (crash or retry in between).
    output = brokerRound.output as BrokerOutput;
  } else {
    const requesterRound = await deps.store.getRound(requestId, 1, 'requester-delegate');
    if (requesterRound?.status !== 'done') throw new NegotiationError(`Round 1 of ${requestId} is not finished`);
    const provider = await requireTeam(deps, request.providerTeamId);
    const ranked = rankOptions(await deps.store.listOptions(requestId));
    if (ranked.length === 0) throw new NegotiationError(`No options stored for ${requestId}`);
    const recommended = ranked[0];
    const renegotiation = await deps.store.getRenegotiation(requestId);
    output = await runRound(deps, requestId, 2, 'broker', { optionCount: ranked.length }, async () => {
      await deps.store.setRecommended(requestId, recommended.id);
      const recommendedDates = formatDateRange(recommended.dateRange.min, recommended.dateRange.max, 'no date offered');
      // Only the source issue is commented: its creator was checked for ADD_COMMENTS there. Provider issues
      // the option would shift are not commented, because the requester has no permission on them (NFR-3);
      // the provider lead sees them in the deal sheet and Inbox. A renegotiation gets this one comment
      // ("renegotiation opened"); the risk itself was already announced by the monitor.
      await commentOnce(
        deps,
        requestId,
        renegotiation ? renegotiationCommentStep(request.sourceIssueKey) : `comment:deal-sheet:${request.sourceIssueKey}`,
        request.sourceIssueKey,
        renegotiation
          ? `Accord: the contract for ${quotedTitle(request.title)} (${provider.name}) is at risk, so Accord opened a renegotiation. ` +
              `The new deal sheet has ${plural(ranked.length, 'option')}; recommended delivery: ${recommendedDates}. ` +
              'The current contract stays in effect until both team leads approve a new option in the Accord panel.'
          : `Accord: the deal sheet for ${quotedTitle(request.title)} (${provider.name}) is ready with ${plural(ranked.length, 'option')}. ` +
              `Recommended delivery: ${recommendedDates}. ` +
              'Nothing changes in Jira until both team leads approve the same option in the Accord panel.',
      );
      return { rankedOptionIds: ranked.map((option) => option.id), recommendedOptionId: recommended.id };
    });
  }
  if (await deps.store.transition(requestId, ['negotiating'], 'awaiting-approval')) {
    await deps.store.audit('request', requestId, 'deal-sheet-ready', null, output);
  }
  return { status: 'done', detail: `${plural(output.rankedOptionIds.length, 'option')}, recommended ${output.recommendedOptionId}` };
}

/**
 * At-most-once comment: the SQL marker is written before posting, so a crash or retry
 * never posts twice. A failed post is logged and audited, not retried (comments are notifications).
 */
async function commentOnce(deps: NegotiationDeps, requestId: string, step: string, issueKey: string, text: string) {
  if (await deps.store.hasStep(requestId, step)) return;
  await deps.store.audit('request', requestId, step, null, { issueKey, as: 'app', reason: APP_ACTOR_REASON });
  try {
    await deps.jira.addComment(issueKey, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Accord comment on ${issueKey} for ${requestId} failed`, message);
    await deps.store.audit('request', requestId, 'comment-failed', null, { step, issueKey, error: message.slice(0, 500) });
  }
}

export function storedDecision(output: unknown): RequesterDecision | null {
  if (!output || typeof output !== 'object' || !('decision' in output)) return null;
  return (output as { decision: RequesterDecision }).decision;
}

export interface DecisionInput {
  requestId: string;
  optionId: number;
  side: Side;
  decision: 'approve' | 'reject';
  reason?: string;
  /** From the Forge invocation context, never from the UI payload. */
  accountId: string | undefined;
}

export type DecisionResult = { status: 'recorded' | 'agreed' | 'rejected' | 'waiting-for-other-side'; detail: string };

function changedMeanwhile(status: RequestStatus | undefined): NegotiationError {
  return new NegotiationError(
    `This request changed to ${status ?? 'an unknown status'} while you were deciding; your decision was not recorded. Reload the deal sheet.`,
  );
}

/** Outcome after our approval was stored but the request moved on concurrently: report the real status. */
async function concurrentOutcome(deps: NegotiationDeps, requestId: string): Promise<DecisionResult> {
  const current = await deps.store.getRequest(requestId);
  if (current?.status === 'rejected') {
    return { status: 'rejected', detail: 'the other team lead rejected the request at the same time' };
  }
  if (current?.status === 'approved' || current?.status === 'contracted') {
    return { status: 'agreed', detail: 'both leads approved the same option' };
  }
  throw changedMeanwhile(current?.status);
}

/** Jira permissions an approver needs for the changes apply-contract makes on their side. */
export const SIDE_PERMISSIONS = {
  // Provider: the deliverable is created and shifted issues move sprints in the provider project.
  provider: ['CREATE_ISSUES', 'SCHEDULE_ISSUES'],
  // Requester: the source issue gets the blocks link and the contract comment.
  requester: ['LINK_ISSUES', 'ADD_COMMENTS'],
} as const satisfies Record<Side, readonly JiraPermission[]>;

export interface PermissionCheck {
  scope: string;
  required: JiraPermission[];
  granted: JiraPermission[];
  missing: JiraPermission[];
}

/** Checks, as the signed-in user, the Jira permissions behind their side of the contract. */
async function checkApproverPermissions(deps: NegotiationDeps, request: DependencyRequest, team: Team, side: Side): Promise<PermissionCheck> {
  const required: JiraPermission[] = [...SIDE_PERMISSIONS[side]];
  const scope = side === 'provider' ? { projectKey: team.jiraProjectKey } : { issueKey: request.sourceIssueKey };
  const label = side === 'provider' ? `project ${team.jiraProjectKey}` : request.sourceIssueKey;
  let granted: Set<JiraPermission>;
  try {
    granted = await deps.userPermissions(scope, required);
  } catch (error) {
    // Fail closed: without a successful check nothing is approved.
    console.error(`Accord permission check for ${request.id} failed`, error instanceof Error ? error.message : String(error));
    granted = new Set();
  }
  return {
    scope: label,
    required,
    granted: required.filter((permission) => granted.has(permission)),
    missing: required.filter((permission) => !granted.has(permission)),
  };
}

/**
 * Records a human decision; two approvals of the same option enqueue apply-contract.
 * Races are settled by conditional SQL: a rejection first claims the status
 * (`awaiting-approval` → `rejected`), an approval is only inserted while the request is
 * still awaiting approval, and only one caller wins `awaiting-approval` → `approved`.
 */
export async function decide(deps: NegotiationDeps, input: DecisionInput): Promise<DecisionResult> {
  if (!input.accountId) throw new NegotiationError('A signed-in Jira user is required to decide.');
  const request = await requireRequest(deps, input.requestId);
  if (request.status !== 'awaiting-approval') {
    throw new NegotiationError(`This request is ${request.status}; decisions are only possible while awaiting approval.`);
  }
  const brokerRound = await deps.store.getRound(request.id, 2, 'broker');
  const ranked = (brokerRound?.output as { rankedOptionIds?: number[] } | null)?.rankedOptionIds ?? [];
  if (!ranked.includes(input.optionId)) throw new NegotiationError(`Option ${input.optionId} is not on this deal sheet.`);
  const option = (await deps.store.listOptions(request.id)).find((item) => item.id === input.optionId);
  if (!option) throw new NegotiationError(`Option ${input.optionId} not found.`);
  if (input.decision === 'approve' && option.kind === 'reject') {
    throw new NegotiationError('A decline option cannot be approved; reject the request instead.');
  }
  const teamId = input.side === 'requester' ? request.requesterTeamId : request.providerTeamId;
  const team = await requireTeam(deps, teamId);
  const approvers = await deps.teams.approvers(team);
  if (!approvers.includes(input.accountId)) {
    await deps.store.audit('request', request.id, 'decision-denied', input.accountId, { side: input.side, teamId });
    throw new NegotiationError(`You are not an approver for ${team.name}. Approvers come from the team charter and the project lead.`);
  }
  const permissionCheck = input.decision === 'approve' ? await checkApproverPermissions(deps, request, team, input.side) : null;
  if (permissionCheck && permissionCheck.missing.length > 0) {
    await deps.store.audit('request', request.id, 'decision-denied', input.accountId, {
      side: input.side,
      teamId,
      rule: 'jira-permissions',
      ...permissionCheck,
    });
    throw new NegotiationError(
      `You cannot approve for ${team.name}: Accord applies the contract in Jira on your behalf, and you are missing ` +
        `${permissionCheck.missing.join(', ')} on ${permissionCheck.scope}. Ask a Jira admin for these permissions.`,
    );
  }
  const reason = input.reason?.trim().slice(0, 1000) || null;
  const approval = { requestId: request.id, optionId: input.optionId, teamId, actorAccountId: input.accountId, decision: input.decision, reason };

  if (input.decision === 'reject') {
    if (!reason) throw new NegotiationError('A reason is required to reject.');
    if (!(await deps.store.transition(request.id, ['awaiting-approval'], 'rejected'))) {
      throw changedMeanwhile((await deps.store.getRequest(request.id))?.status);
    }
    await deps.store.addApproval(approval, 'rejected');
    await deps.store.audit('request', request.id, 'rejected', input.accountId, { optionId: input.optionId, teamId, side: input.side, reason });
    await escalateSafely(deps, request.id, 'rejected');
    return { status: 'rejected', detail: reason };
  }

  const otherTeamId = input.side === 'requester' ? request.providerTeamId : request.requesterTeamId;
  const before = approvalState(await deps.store.listApprovals(request.id), request.requesterTeamId, request.providerTeamId);
  const otherApproval = otherTeamId === request.requesterTeamId ? before.requester : before.provider;
  // True only when demo mode lets the same account approve for both teams; recorded in the audit entry.
  let demoMode = false;
  if (otherApproval?.decision === 'approve' && otherApproval.actorAccountId === input.accountId) {
    const otherTeam = await requireTeam(deps, otherTeamId);
    const teams = input.side === 'requester' ? { requester: team, provider: otherTeam } : { requester: otherTeam, provider: team };
    if (!(await deps.allowSameApprover(teams))) {
      await deps.store.audit('request', request.id, 'decision-denied', input.accountId, { side: input.side, teamId, rule: 'dual-control' });
      throw new NegotiationError('Dual control: you already approved for the other team, so another lead must approve for this team.');
    }
    demoMode = true;
  }

  if (!(await deps.store.addApproval(approval, 'awaiting-approval'))) {
    throw changedMeanwhile((await deps.store.getRequest(request.id))?.status);
  }
  await deps.store.audit('request', request.id, 'approved', input.accountId, {
    optionId: input.optionId,
    teamId,
    side: input.side,
    permissions: permissionCheck,
    ...(demoMode ? { demoMode: true } : {}),
  });

  const state = approvalState(await deps.store.listApprovals(request.id), request.requesterTeamId, request.providerTeamId);
  if (state.agreedOptionId !== null) {
    // Conditional transition: only one concurrent caller fixes the contract option and enqueues apply-contract.
    if (!(await deps.store.transition(request.id, ['awaiting-approval'], 'approved'))) return concurrentOutcome(deps, request.id);
    const agreed = state.agreedOptionId === option.id ? option : (await deps.store.listOptions(request.id)).find((o) => o.id === state.agreedOptionId);
    if (agreed) await deps.store.ensureContract(request.id, agreed.id, agreed.dateRange);
    await deps.queue.push({ type: 'apply-contract', requestId: request.id });
    return { status: 'agreed', detail: `option ${state.agreedOptionId}` };
  }
  const current = await deps.store.getRequest(request.id);
  if (current?.status !== 'awaiting-approval') return concurrentOutcome(deps, request.id);
  const other = input.side === 'requester' ? state.provider : state.requester;
  return other
    ? { status: 'recorded', detail: `the other team approved option ${other.optionId}; both must approve the same option` }
    : { status: 'waiting-for-other-side', detail: 'waiting for the other team lead' };
}

/** The contract fixed at agreement time; older rows without one fall back to the approvals. */
async function agreedContract(deps: NegotiationDeps, request: DependencyRequest): Promise<Contract> {
  const existing = await deps.store.getContract(request.id);
  if (existing) return existing;
  const state = approvalState(await deps.store.listApprovals(request.id), request.requesterTeamId, request.providerTeamId);
  if (state.agreedOptionId === null) throw new NegotiationError(`Request ${request.id} has no option approved by both teams`);
  const option = (await deps.store.listOptions(request.id)).find((item) => item.id === state.agreedOptionId);
  if (!option) throw new NegotiationError(`Option ${state.agreedOptionId} not found`);
  return deps.store.ensureContract(request.id, option.id, option.dateRange);
}

/**
 * Creates the provider deliverable at most once. Primary key: `contracts.deliverable_issue_key`.
 * Before calling Jira an intent marker is stored in SQL; if a later attempt finds the intent but
 * no key, the unique contract label is searched (JQL fallback) and creation waits
 * DELIVERABLE_SEARCH_GRACE_SECONDS for the search index before trying again.
 */
async function ensureDeliverable(deps: NegotiationDeps, request: DependencyRequest, provider: Team, contract: Contract, dueDate: string) {
  if (contract.deliverableIssueKey) return contract.deliverableIssueKey;
  const label = contractLabel(request.id);
  let deliverable = await deps.jira.findIssueByLabel(provider.jiraProjectKey, label);
  if (!deliverable) {
    const intentAge = await deps.store.lastStepAgeSeconds(request.id, DELIVERABLE_INTENT);
    if (intentAge !== null && intentAge < DELIVERABLE_SEARCH_GRACE_SECONDS) {
      throw new NegotiationError(
        `A deliverable for ${request.id} may have been created ${intentAge}s ago; waiting for Jira search before creating it again`,
      );
    }
    await deps.store.audit('request', request.id, DELIVERABLE_INTENT, null, { label, as: 'app', reason: APP_ACTOR_REASON });
    deliverable = await deps.jira.createIssue(provider.jiraProjectKey, request.title, dueDate, ['accord', label]);
    await deps.store.audit('contract', String(contract.id), 'deliverable-created', null, { issueKey: deliverable, as: 'app', reason: APP_ACTOR_REASON });
  }
  await deps.store.setContractDeliverable(request.id, deliverable);
  return deliverable;
}

const DUE_DATE_STEP = 'contract:due-date';

/** Renegotiated contract: points at the replaced contract's deliverable and moves its due date (once). */
async function reuseDeliverable(
  deps: NegotiationDeps,
  request: DependencyRequest,
  contract: Contract,
  issueKey: string,
  dueDate: IsoDate,
  actor: Record<string, unknown>,
): Promise<string> {
  if (contract.deliverableIssueKey !== issueKey) await deps.store.setContractDeliverable(request.id, issueKey);
  if (!(await deps.store.hasStep(request.id, DUE_DATE_STEP))) {
    await deps.jira.setDueDate(issueKey, dueDate);
    await deps.store.audit('request', request.id, DUE_DATE_STEP, null, { issueKey, dueDate, ...actor });
  }
  return issueKey;
}

const DELIVERABLE_SPRINT_STEP = 'contract:deliverable-sprint';

/**
 * Puts the deliverable into the sprint the planner used for the agreed option (read from the option trace,
 * never recomputed). A sprint that does not exist in Jira yet leaves a new deliverable in the backlog; a
 * renegotiation (`existing`) moves its kept deliverable to the backlog then. Returns the sentence for the
 * deliverable comment, null for options stored before the planner recorded the sprint. A failed move is
 * audited and does not stop the contract (the deliverable stays where it is).
 */
async function placeDeliverable(
  deps: NegotiationDeps,
  requestId: string,
  option: StoredOption,
  deliverable: string,
  existing: boolean,
  actor: Record<string, unknown>,
): Promise<string | null> {
  const sprint = deliverableSprintOf(option.trace);
  if (!sprint) return null;
  const planned = sprint.inJira
    ? `Deliverable planned in ${sprint.name}.`
    : `The deliverable stays in the backlog: it is planned for ${sprint.name}, which does not exist in Jira yet.`;
  if (await deps.store.hasStep(requestId, DELIVERABLE_SPRINT_STEP)) return planned;
  try {
    if (sprint.inJira) await deps.jira.moveToSprint(sprint.id, [deliverable]);
    else if (existing) await deps.jira.moveToBacklog([deliverable]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.audit('request', requestId, 'deliverable-sprint-failed', null, { issueKey: deliverable, sprintId: sprint.id, error: message.slice(0, 500) });
    return null;
  }
  await deps.store.audit('request', requestId, DELIVERABLE_SPRINT_STEP, null, {
    issueKey: deliverable,
    ...(sprint.inJira ? { sprintId: sprint.id, sprintName: sprint.name } : { backlog: true, plannedFor: sprint.name, reason: 'sprint does not exist in Jira yet' }),
    ...actor,
  });
  return planned;
}

/** Writes the agreement to Jira and SQL. Every step is guarded, so a retry never duplicates (NFR-5, NFR-7). */
export async function applyContract(deps: NegotiationDeps, requestId: string): Promise<RoundResult> {
  const request = await requireRequest(deps, requestId);
  if (request.status === 'contracted') return { status: 'skipped', detail: 'already contracted' };
  if (request.status !== 'approved') return { status: 'skipped', detail: `request is ${request.status}` };
  // The option comes from the stored contract, never recomputed, so contract and Jira changes always match.
  const contract = await agreedContract(deps, request);
  const option = (await deps.store.listOptions(requestId)).find((item) => item.id === contract.optionId);
  if (!option) throw new NegotiationError(`Option ${contract.optionId} of contract ${contract.id} not found`);
  const [requester, provider] = await Promise.all([
    requireTeam(deps, request.requesterTeamId),
    requireTeam(deps, request.providerTeamId),
  ]);
  const state = approvalState(await deps.store.listApprovals(requestId), request.requesterTeamId, request.providerTeamId);
  const actor = { as: 'app', reason: APP_ACTOR_REASON, approvedBy: [state.requester?.actorAccountId, state.provider?.actorAccountId] };
  const dates = { min: contract.agreedDateMin, max: contract.agreedDateMax };
  const renegotiation = await deps.store.getRenegotiation(requestId);
  const parentContract = renegotiation ? await deps.store.getContract(renegotiation.parentRequestId) : null;

  // A renegotiation keeps the deliverable of the contract it replaces and only moves its due date.
  const deliverableCreated = !parentContract?.deliverableIssueKey;
  const deliverable = parentContract?.deliverableIssueKey
    ? await reuseDeliverable(deps, request, contract, parentContract.deliverableIssueKey, dates.max, actor)
    : await ensureDeliverable(deps, request, provider, contract, dates.max);

  if (!(await deps.jira.hasBlocksLink(deliverable, request.sourceIssueKey))) {
    await deps.jira.linkBlocks(deliverable, request.sourceIssueKey);
    await deps.store.audit('contract', String(contract.id), LINK_CREATED_STEP, null, {
      blocker: deliverable,
      blocked: request.sourceIssueKey,
      ...actor,
    });
  }

  const placement = await placeDeliverable(deps, requestId, option, deliverable, !deliverableCreated, actor);

  if (option.shifted.length > 0 && !(await deps.store.hasStep(requestId, 'contract:shift'))) {
    // Recorded before the moves, so "Clean demo data" can put every shifted issue back (also after a crash).
    await deps.store.recordShiftOrigins(
      requestId,
      option.shifted
        .filter((item) => item.fromSprintId !== undefined)
        .map((item) => ({
          issueKey: item.key,
          fromSprintId: item.fromSprintId ?? null,
          toSprintId: isProjectedSprint(item.toSprintId) ? null : item.toSprintId,
        })),
    );
    const toBacklog = option.shifted.filter((item) => isProjectedSprint(item.toSprintId)).map((item) => item.key);
    const bySprint = new Map<string, string[]>();
    for (const item of option.shifted.filter((shifted) => !isProjectedSprint(shifted.toSprintId))) {
      bySprint.set(item.toSprintId, [...(bySprint.get(item.toSprintId) ?? []), item.key]);
    }
    for (const [sprintId, keys] of bySprint) await deps.jira.moveToSprint(sprintId, keys);
    if (toBacklog.length) await deps.jira.moveToBacklog(toBacklog);
    await deps.store.audit('request', requestId, 'contract:shift', null, {
      moved: Object.fromEntries(bySprint),
      backlog: toBacklog,
      ...actor,
    });
  }

  const agreed = formatDateRange(dates.min, dates.max);
  const replaces = parentContract ? ` This replaces the earlier agreement (${formatDateRange(parentContract.agreedDateMin, parentContract.agreedDateMax)}).` : '';
  // Same words as the deal sheet's applied changes ("Created X" / "Linked existing X").
  const provenance = `${deliverableCreated ? 'Created' : 'Linked existing'} ${deliverable} in ${provider.jiraProjectKey}.`;
  await commentOnce(
    deps,
    requestId,
    `comment:contract:${request.sourceIssueKey}`,
    request.sourceIssueKey,
    `Accord contract: ${provider.name} delivers ${quotedTitle(request.title)}, agreed ${agreed}. ${provenance} ` +
      `Approved by the ${requester.name} and ${provider.name} leads.${replaces}`,
  );
  await commentOnce(
    deps,
    requestId,
    `comment:contract:${deliverable}`,
    deliverable,
    `Accord contract with ${requester.name} (${request.sourceIssueKey}): agreed delivery ${agreed}. ${provenance}` +
      (placement ? ` ${placement}` : '') +
      (option.shifted.length ? ` Moved to make room: ${option.shifted.map((item) => item.key).join(', ')}.` : '') +
      replaces,
  );

  await deps.store.ensureEdge(contract.id, request.requesterTeamId, request.providerTeamId);
  if (renegotiation && parentContract && parentContract.status !== 'superseded') {
    // Kept for history, no longer monitored (the monitor's conditional update loses against this change).
    await deps.store.setContractStatus(renegotiation.parentRequestId, 'superseded');
    await deps.store.audit('contract', String(parentContract.id), 'contract-superseded', null, {
      supersededByRequestId: requestId,
      supersededByContractId: contract.id,
      ...actor,
    });
  }
  await deps.store.setContractStatus(requestId, 'on-track');
  const linkCreated = await deps.store.hasContractStep(contract.id, LINK_CREATED_STEP);
  if (await deps.store.transition(requestId, ['approved'], 'contracted')) {
    await deps.store.audit('contract', String(contract.id), 'contract-applied', null, {
      requestId,
      optionId: option.id,
      deliverable,
      deliverableCreated,
      linkCreated,
      agreed: dates,
      ...actor,
    });
  }
  // Fill the projected date right away instead of waiting for the daily run (evaluation is idempotent).
  try {
    await deps.monitor.evaluateProvider(request.providerTeamId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.audit('contract', String(contract.id), 'monitor-enqueue-failed', null, { error: message.slice(0, 500) });
  }
  return {
    status: 'done',
    detail: `contract ${contract.id}, ${deliverableCreated ? 'created' : 'linked existing'} ${deliverable}${linkCreated ? '' : ' (blocks link already there)'}`,
  };
}

export function contractLabel(requestId: string): string {
  return `accord-${requestId}`;
}

/**
 * Re-queues a stalled request (FR "Retry negotiation"): `failed`, or `negotiating`/`approved`
 * without any activity for STUCK_AFTER_SECONDS. Every job is idempotent, so a duplicate is harmless.
 * Allowed for approvers of either team and the creator.
 */
export async function retryRequest(deps: NegotiationDeps, requestId: string, accountId: string | undefined): Promise<RoundResult> {
  if (!accountId) throw new NegotiationError('A signed-in Jira user is required.');
  const request = await requireRequest(deps, requestId);
  const [requester, provider] = await Promise.all([
    requireTeam(deps, request.requesterTeamId),
    requireTeam(deps, request.providerTeamId),
  ]);
  const allowed =
    request.createdBy === accountId ||
    (await deps.teams.approvers(requester)).includes(accountId) ||
    (await deps.teams.approvers(provider)).includes(accountId);
  if (!allowed) throw new NegotiationError('Only the requester or a lead of either team can retry this request.');

  const agreed = approvalState(await deps.store.listApprovals(requestId), request.requesterTeamId, request.providerTeamId).agreedOptionId !== null;
  if (request.status === 'failed') {
    const target = agreed ? 'approved' : 'negotiating';
    if (!(await deps.store.transition(requestId, ['failed'], target))) throw changedMeanwhile((await deps.store.getRequest(requestId))?.status);
  } else if (request.status === 'negotiating' || request.status === 'approved') {
    const idle = await deps.store.lastStepAgeSeconds(requestId);
    if (idle !== null && idle < STUCK_AFTER_SECONDS) {
      throw new NegotiationError(`Accord is still working on this request; retry is possible after ${Math.ceil(STUCK_AFTER_SECONDS / 60)} minutes without progress.`);
    }
  } else {
    throw new NegotiationError(`A ${request.status} request cannot be retried.`);
  }
  const type = request.status === 'approved' || (request.status === 'failed' && agreed) ? 'apply-contract' : 'round1';
  await deps.queue.push({ type, requestId });
  await deps.store.audit('request', requestId, 'retry-requested', accountId, { from: request.status, job: type });
  return { status: 'done', detail: `${type} queued again` };
}

export interface NewRequestInput {
  sourceIssueKey: string;
  requesterTeam: Team;
  providerTeam: Team;
  title: string;
  size: Size;
  minSize: number | null;
  neededBy: string;
  costClass: CostClass;
  /** Account id of the creator, or APP_CREATOR for requests Accord opens itself. */
  createdBy: string;
  /** Renegotiation (FR-14): the contracted request it renegotiates, and why it was opened. */
  parentRequestId?: string;
  note?: string;
}

const SIZES: readonly Size[] = ['S', 'M', 'L'];
export const COST_CLASSES: readonly CostClass[] = ['fixed-date', 'standard', 'intangible'];

export const MAX_TITLE_LENGTH = 120;
/** New requests one provider team accepts per hour (spam guard, all requesters together). */
export const MAX_REQUESTS_PER_PROVIDER_PER_HOUR = 20;

/**
 * Request titles end up in Jira comments and agent context: one line, no control or
 * format characters, double quotes replaced so a title cannot close the quoted text.
 */
export function normalizeTitle(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

/** Title as quoted text in comments (stored titles from before normalization are cleaned too). */
export const quotedTitle = (title: string): string => `"${normalizeTitle(title)}"`;

export function validateNewRequest(input: Omit<NewRequestInput, 'requesterTeam' | 'providerTeam'>, today: string): string | null {
  if (!normalizeTitle(input.title)) return `Title is required (one line; longer titles are cut to ${MAX_TITLE_LENGTH} characters).`;
  if (!SIZES.includes(input.size)) return 'Size must be S, M or L.';
  if (!COST_CLASSES.includes(input.costClass)) return 'Cost class must be fixed-date, standard or intangible.';
  if (!isValidIsoDate(input.neededBy)) return 'Needed by must be a date in YYYY-MM-DD format.';
  if (input.neededBy <= today) return 'Needed by must be in the future.';
  if (input.minSize !== null && !(Number.isInteger(input.minSize) && input.minSize >= 1 && input.minSize <= 6)) {
    return 'Minimum useful size must be a whole number of issues between 1 and 6.';
  }
  if (!input.createdBy) return 'A signed-in user is required.';
  return null;
}

/**
 * Stores the request as `negotiating` and enqueues round 1. Does not touch Jira.
 * If the queue push fails the request is marked `failed` with the reason (no orphan in `negotiating`).
 */
export async function createRequest(deps: NegotiationDeps, input: NewRequestInput, id: string): Promise<DependencyRequest> {
  const error = validateNewRequest(input, deps.today());
  if (error) throw new NegotiationError(error);
  if (input.requesterTeam.id === input.providerTeam.id) throw new NegotiationError('A team cannot request work from itself.');
  const request: DependencyRequest = {
    id,
    requesterTeamId: input.requesterTeam.id,
    providerTeamId: input.providerTeam.id,
    sourceIssueKey: input.sourceIssueKey,
    title: normalizeTitle(input.title),
    size: input.size,
    minSize: input.minSize,
    neededBy: input.neededBy,
    costClass: input.costClass,
    status: 'negotiating',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  const inserted = await deps.store.insertRequest(request, { maxPerProviderPerHour: MAX_REQUESTS_PER_PROVIDER_PER_HOUR });
  if (inserted === 'exists') throw new NegotiationError('This request was already created.', 'exists');
  if (inserted === 'duplicate') {
    throw new NegotiationError(
      `${request.sourceIssueKey} already has an open request to ${input.providerTeam.name}. Open its deal sheet instead of creating another one.`,
      'duplicate',
    );
  }
  if (inserted === 'provider-limit') {
    throw new NegotiationError(
      `${input.providerTeam.name} received ${MAX_REQUESTS_PER_PROVIDER_PER_HOUR} requests in the last hour. Try again later.`,
      'provider-limit',
    );
  }
  const byApp = input.createdBy === APP_CREATOR;
  await deps.store.audit('request', id, 'created', byApp ? null : input.createdBy, {
    sourceIssueKey: request.sourceIssueKey,
    provider: input.providerTeam.teamKey,
    size: request.size,
    minSize: request.minSize,
    neededBy: request.neededBy,
    ...(input.parentRequestId ? { parentRequestId: input.parentRequestId, note: input.note ?? null } : {}),
    ...(byApp ? { as: 'app' } : {}),
  });
  try {
    await deps.queue.push({ type: 'round1', requestId: id });
  } catch (pushError) {
    const message = pushError instanceof Error ? pushError.message : String(pushError);
    await deps.store.transition(id, ['negotiating'], 'failed');
    await deps.store.audit('request', id, 'round1-enqueue-failed', null, { error: message.slice(0, 1000) });
    throw new NegotiationError(
      'The request was saved but the negotiation could not be started, so it is marked failed. Use "Retry negotiation".',
      'enqueue-failed',
    );
  }
  return request;
}

const RENEGOTIATION_REASON = 'Contract monitor without a user context; opens the renegotiation as the app (FR-14).';

/** An at-risk evaluation of the monitor, as input for a renegotiation. */
export interface RenegotiationTrigger {
  contract: Contract;
  /** The contracted request of `contract`. */
  request: DependencyRequest;
  projectedDate: IsoDate | null;
  /** Notification sequence of the at-risk announcement: one renegotiation per contract and episode. */
  episode: number;
  /**
   * The monitor's at-risk comment on the source issue (posted right after) also announces this renegotiation,
   * so round 2 does not comment on the source issue a second time.
   */
  announcedByMonitor?: boolean;
}

/** Marker of the one "renegotiation opened" comment on the source issue (written by round 2 or the monitor). */
const renegotiationCommentStep = (sourceIssueKey: string) => `comment:renegotiation:${sourceIssueKey}`;

export type RenegotiationResult = { status: 'opened' | 'exists' | 'skipped'; requestId: string | null; detail: string };

/**
 * Opens a renegotiation for an at-risk contract (FR-14): a new request between the same teams, created by the
 * app and negotiated by the same rounds and planner. Idempotent: an open renegotiation of the contract, or one
 * already opened for this at-risk episode, is returned instead of opening another. The claim row is written
 * before the request, so a crash in between reuses the claimed id on the next monitor run.
 */
export async function openRenegotiation(deps: NegotiationDeps, trigger: RenegotiationTrigger, newId: string): Promise<RenegotiationResult> {
  const { contract, request: parent } = trigger;
  const open = await deps.store.openRenegotiationFor(contract.id);
  if (open) return { status: 'exists', requestId: open, detail: 'a renegotiation of this contract is already open' };
  const requestId = await deps.store.claimRenegotiation({
    requestId: newId,
    parentRequestId: parent.id,
    contractId: contract.id,
    episode: trigger.episode,
  });
  if (await deps.store.getRequest(requestId)) return { status: 'exists', requestId, detail: 'already opened for this at-risk change' };

  const [requesterTeam, providerTeam] = await Promise.all([
    requireTeam(deps, parent.requesterTeamId),
    requireTeam(deps, parent.providerTeamId),
  ]);
  const today = deps.today();
  // The requester's need date stands; once it has passed, the agreed date is the target.
  const neededBy = [parent.neededBy, contract.agreedDateMax].find((date) => date > today) ?? null;
  const subject = `${contract.deliverableIssueKey ?? `contract ${contract.id}`} → ${parent.sourceIssueKey}`;
  const note = `Renegotiation: contract ${subject} at risk; projected finish ${formatDate(trigger.projectedDate, 'beyond the planning horizon')}`;
  const actor = { as: 'app', reason: RENEGOTIATION_REASON };
  if (!neededBy) {
    await deps.store.audit('request', parent.id, 'renegotiation-skipped', null, {
      contractId: contract.id,
      detail: 'need date and agreed date have both passed',
      ...actor,
    });
    return { status: 'skipped', requestId: null, detail: 'need date and agreed date have passed' };
  }
  if (trigger.announcedByMonitor && !(await deps.store.hasStep(requestId, renegotiationCommentStep(parent.sourceIssueKey)))) {
    // Written before round 1 is queued, so round 2 never races the monitor's combined comment.
    await deps.store.audit('request', requestId, renegotiationCommentStep(parent.sourceIssueKey), null, {
      issueKey: parent.sourceIssueKey,
      via: 'monitor',
      ...actor,
    });
  }
  try {
    await createRequest(
      deps,
      {
        sourceIssueKey: parent.sourceIssueKey,
        requesterTeam,
        providerTeam,
        title: parent.title,
        size: parent.size,
        minSize: parent.minSize,
        neededBy,
        costClass: parent.costClass,
        createdBy: APP_CREATOR,
        parentRequestId: parent.id,
        note,
      },
      requestId,
    );
  } catch (error) {
    const code = error instanceof NegotiationError ? error.code : undefined;
    // A parallel monitor run stored the same claimed request first: not a failure.
    if (code === 'exists') return { status: 'exists', requestId, detail: 'opened by a parallel monitor run' };
    // Nothing stored (provider limit, duplicate, transient error): free the episode so a later run retries it.
    // An enqueue failure stored the request as failed; it keeps its claim and is retried from the UI.
    if (code !== 'enqueue-failed') await deps.store.releaseRenegotiation(requestId);
    if (code === 'duplicate') {
      return { status: 'exists', requestId: null, detail: 'the source issue already has an open request to this team' };
    }
    if (!(error instanceof NegotiationError)) throw error;
    await deps.store.audit('request', parent.id, 'renegotiation-failed', null, {
      contractId: contract.id,
      episode: trigger.episode,
      retried: code !== 'enqueue-failed',
      error: error.message.slice(0, 500),
    });
    return { status: 'skipped', requestId: null, detail: error.message };
  }
  await deps.store.audit('request', requestId, 'renegotiation-opened', null, {
    parentRequestId: parent.id,
    contractId: contract.id,
    episode: trigger.episode,
    projectedDate: trigger.projectedDate,
    agreedDateMax: contract.agreedDateMax,
    note,
    ...actor,
  });
  return { status: 'opened', requestId, detail: note };
}

/**
 * Withdraws the renegotiations of a provider that nobody decided yet (demo reset): status `cancelled`,
 * audited, nothing deleted. Approved or contracted renegotiations stay untouched.
 */
export async function cancelUndecidedRenegotiations(
  deps: NegotiationDeps,
  providerTeamId: string,
  actor: string | null,
  reason: string,
): Promise<string[]> {
  const cancelled: string[] = [];
  for (const requestId of await deps.store.undecidedRenegotiations(providerTeamId)) {
    if (!(await deps.store.transition(requestId, ['negotiating', 'awaiting-approval'], 'cancelled'))) continue;
    await deps.store.audit('request', requestId, 'cancelled', actor, { reason });
    cancelled.push(requestId);
  }
  return cancelled;
}

export const BACK_ON_TRACK_REASON = 'Contract back on track';
const BACK_ON_TRACK_ACTOR_REASON = 'Contract monitor without a user context; withdraws the renegotiation as the app (FR-14).';

export interface BackOnTrackCancellation {
  cancelled: string[];
  /** True when a cancelled renegotiation had been announced on the source issue (so its withdrawal is worth a sentence). */
  announced: boolean;
}

/**
 * The monitor sees the renegotiated contract on track again: its renegotiations nobody finished deciding are
 * withdrawn (status `cancelled`, audited as the app). A lead that already approved an option is named in the
 * audit; an option approved by both teams (`approved`) is no longer undecided and goes ahead.
 */
export async function cancelRenegotiationsBackOnTrack(
  deps: NegotiationDeps,
  parent: DependencyRequest,
  contractId: number,
): Promise<BackOnTrackCancellation> {
  const result: BackOnTrackCancellation = { cancelled: [], announced: false };
  for (const requestId of await deps.store.undecidedRenegotiations(parent.providerTeamId, contractId)) {
    if (!(await deps.store.transition(requestId, ['negotiating', 'awaiting-approval'], 'cancelled'))) continue;
    const approvals = (await deps.store.listApprovals(requestId)).filter((approval) => approval.decision === 'approve');
    const approvedBy = await Promise.all(
      approvals.map(async (approval) => ({
        teamId: approval.teamId,
        accountId: approval.actorAccountId,
        name: await deps.jira.displayName(approval.actorAccountId).catch(() => null),
      })),
    );
    await deps.store.audit('request', requestId, 'renegotiation-cancelled', null, {
      reason: BACK_ON_TRACK_REASON,
      parentRequestId: parent.id,
      contractId,
      approvedBy,
      as: 'app',
      actorReason: BACK_ON_TRACK_ACTOR_REASON,
    });
    result.cancelled.push(requestId);
    if (await deps.store.hasStep(requestId, renegotiationCommentStep(parent.sourceIssueKey))) result.announced = true;
  }
  return result;
}

export const ESCALATED_STEP = 'escalated';
export const ESCALATION_FAILED_STEP = 'escalation-failed';
export type EscalationTrigger = 'rejected' | 'failed';
const ESCALATION_REASON = 'Request ended without agreement; Accord posts the neutral escalation summary as the app (FR-15).';

/** User text in a comment: one line, no control characters, bounded. */
const oneLine = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Neutral summary: both teams, the trigger, and the stored numbers (need date, options, contract dates). */
async function escalationSummary(
  deps: NegotiationDeps,
  request: DependencyRequest,
  requester: Team,
  provider: Team,
  trigger: EscalationTrigger,
): Promise<string> {
  const lines = [
    `Accord escalation: ${requester.name} and ${provider.name} reached no agreement on ${quotedTitle(request.title)} (${request.sourceIssueKey}).`,
  ];
  if (trigger === 'rejected') {
    const rejection = (await deps.store.listApprovals(request.id)).find((approval) => approval.decision === 'reject');
    if (rejection) {
      const team = rejection.teamId === requester.id ? requester : provider;
      const reason = rejection.reason ? oneLine(rejection.reason, 300) : '';
      lines.push(`The ${team.name} lead rejected the deal sheet.${reason ? ` Reason given: "${reason.replace(/"/g, "'")}".` : ''}`);
    } else {
      // No stored rejection (e.g. removed data): do not guess which team rejected.
      lines.push('The deal sheet was rejected.');
    }
  } else {
    lines.push('Accord could not finish the negotiation: a background step failed after several attempts.');
  }
  lines.push(`Needed by ${formatDate(request.neededBy)}; size ${request.size}.`);
  const renegotiation = await deps.store.getRenegotiation(request.id);
  const parentContract = renegotiation ? await deps.store.getContract(renegotiation.parentRequestId) : null;
  if (parentContract) {
    lines.push(
      `This was a renegotiation of the contract agreed ${formatDateRange(parentContract.agreedDateMin, parentContract.agreedDateMax)}, ` +
        `projected for ${formatDate(parentContract.projectedDate, 'beyond the planning horizon')}; that contract stays in effect.`,
    );
  }
  const broker = await deps.store.getRound(request.id, 2, 'broker');
  const rankedIds = (broker?.output as { rankedOptionIds?: number[] } | null)?.rankedOptionIds ?? [];
  const options = await deps.store.listOptions(request.id);
  const ranked = rankedIds.map((id) => options.find((option) => option.id === id)).filter((option): option is StoredOption => Boolean(option));
  if (ranked.length > 0) {
    const listed = ranked.map((option) => `${KIND_LABEL[option.kind]} (${formatDateRange(option.dateRange.min, option.dateRange.max, 'no date')})`);
    lines.push(`Options on the deal sheet: ${listed.join('; ')}.`);
  }
  lines.push('Please help both team leads decide. Nothing changes in Jira until both approve the same option in Accord.');
  return lines.join('\n');
}

/**
 * Escalates a rejected or failed request (FR-15) to the escalation contact of each team's charter, falling back
 * to the Jira project lead: one neutral comment with mentions on the source issue. At most once per request:
 * the `escalated` marker (with the contacts) is written after the comment was posted; a failed comment is
 * audited as `escalation-failed` and retried by `retryEscalations`.
 */
export async function escalate(deps: NegotiationDeps, requestId: string, trigger: EscalationTrigger): Promise<RoundResult> {
  if (await deps.store.hasStep(requestId, ESCALATED_STEP)) return { status: 'skipped', detail: 'already escalated' };
  const request = await requireRequest(deps, requestId);
  if (request.status !== 'rejected' && request.status !== 'failed') return { status: 'skipped', detail: `request is ${request.status}` };
  const teams = await Promise.all([requireTeam(deps, request.requesterTeamId), requireTeam(deps, request.providerTeamId)]);
  const [requester, provider] = teams;
  const found = await Promise.all(
    teams.map(async (team) => ({ team, contact: await deps.teams.escalationContact(team, request.sourceIssueKey) })),
  );
  for (const { team, contact } of found) {
    if (contact?.note) {
      await deps.store.audit('request', requestId, 'escalation-contact-fallback', null, {
        teamKey: team.teamKey,
        fallback: contact.source,
        note: contact.note,
      });
    }
  }
  // One shared contact of both teams is mentioned once.
  const unique = found
    .flatMap(({ team, contact }) => (contact ? [{ team, contact }] : []))
    .filter((item, index, all) => all.findIndex((other) => other.contact.accountId === item.contact.accountId) === index);
  if (unique.length === 0) {
    await deps.store.audit('request', requestId, 'escalation-skipped', null, { trigger, detail: 'no escalation contact or project lead' });
    return { status: 'skipped', detail: 'no escalation contact' };
  }
  const contacts = await Promise.all(
    unique.map(async ({ team, contact }) => ({
      accountId: contact.accountId,
      source: contact.source,
      ...(contact.note ? { note: contact.note } : {}),
      teamKey: team.teamKey,
      name: (await deps.jira.displayName(contact.accountId)) ?? `the ${team.name} escalation contact`,
    })),
  );
  const text = await escalationSummary(deps, request, requester, provider, trigger);
  try {
    await deps.jira.addComment(request.sourceIssueKey, text, contacts.map((contact) => contact.accountId));
  } catch (error) {
    // No `escalated` marker: no "Escalated" badge, and retryEscalations tries again on the next monitor run.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Accord escalation comment for ${requestId} failed`, message);
    await deps.store.audit('request', requestId, ESCALATION_FAILED_STEP, null, {
      trigger,
      issueKey: request.sourceIssueKey,
      error: message.slice(0, 500),
    });
    return { status: 'skipped', detail: `escalation comment failed: ${message.slice(0, 200)}` };
  }
  // Written only after the comment is posted; it is the idempotency marker and feeds the "Escalated" badge.
  await deps.store.audit('request', requestId, ESCALATED_STEP, null, {
    trigger,
    issueKey: request.sourceIssueKey,
    contacts,
    as: 'app',
    reason: ESCALATION_REASON,
  });
  return { status: 'done', detail: `escalated to ${contacts.map((contact) => contact.name).join(', ')}` };
}

/**
 * Retries escalations whose comment failed (FR-15): requests still rejected or failed, with an
 * `escalation-failed` entry and no `escalated` marker. Called from every monitor schedule run.
 */
export async function retryEscalations(deps: NegotiationDeps, requestIds: readonly string[]): Promise<Array<RoundResult & { requestId: string }>> {
  const results: Array<RoundResult & { requestId: string }> = [];
  for (const requestId of requestIds) {
    const request = await deps.store.getRequest(requestId);
    if (!request || (request.status !== 'rejected' && request.status !== 'failed')) continue;
    try {
      results.push({ requestId, ...(await escalate(deps, requestId, request.status)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.store.audit('request', requestId, ESCALATION_FAILED_STEP, null, { trigger: request.status, error: message.slice(0, 500) });
      results.push({ requestId, status: 'skipped', detail: message.slice(0, 200) });
    }
  }
  return results;
}

/** Escalation never undoes the decision or failure that triggered it: errors are audited, not thrown. */
export async function escalateSafely(deps: NegotiationDeps, requestId: string, trigger: EscalationTrigger): Promise<void> {
  try {
    await escalate(deps, requestId, trigger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Accord escalation for ${requestId} failed`, message);
    await deps.store.audit('request', requestId, ESCALATION_FAILED_STEP, null, { trigger, error: message.slice(0, 500) });
  }
}
