import { planOptions, isValidIsoDate, type CostClass, type PlannerInput, type PlannerOption, type PlannerVariation, type Size } from '../planner';
import { UserFacingError } from '../errors';
import type { Team } from '../teams/repository';
import {
  approvalState,
  isProjectedSprint,
  rankOptions,
  requesterDecision,
  type RequesterDecision,
  type Side,
} from './delegates';
import type { Contract, DependencyRequest, NegotiationDeps, PlanningContext, RequestStatus, StoredOption } from './types';

/**
 * Negotiation orchestration (FR-8..FR-10). Each round runs as its own queue job
 * and checks the stored round status first, so platform retries are safe (NFR-5).
 * Agents never approve: only `decide` (called with the Forge user context) records
 * approvals (NFR-2).
 */

export class NegotiationError extends UserFacingError {
  constructor(message: string) {
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
  // Jira/SQL planning data is loaded at most once per job and shared by both delegates.
  let planning: Promise<PlanningContext> | null = null;
  const context = () => (planning ??= deps.teams.planningContext(provider, request.neededBy));

  const providerRound = await deps.store.getRound(requestId, 1, 'provider-delegate');
  let offers: StoredOption[];
  if (providerRound?.status === 'done') {
    offers = (await deps.store.listOptions(requestId)).filter((option) => option.roundId === providerRound.id);
  } else {
    let stored: StoredOption[] = [];
    await runRound(deps, requestId, 1, 'provider-delegate', { neededBy: request.neededBy }, async (roundId) => {
      const input = plannerInput(deps, request, await context());
      stored = await deps.store.replaceOptions(requestId, roundId, planOptions(input).options.map(toStoredDraft));
      return { planner: inputSummary(input), optionIds: stored.map((option) => option.id) };
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
        const input = plannerInput(deps, request, await context(), decision.variation);
        const result = planOptions(input);
        const stored = await deps.store.replaceOptions(requestId, roundId, result.options.map(toStoredDraft));
        return { decision, variationOptionIds: stored.map((option) => option.id) };
      }
      return { decision, variationOptionIds: [] as number[] };
    });
  }
  await deps.queue.push({ type: 'round2', requestId });
  return { status: 'done', detail: `${offers.length} offers` };
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
    const [requester, provider] = await Promise.all([
      requireTeam(deps, request.requesterTeamId),
      requireTeam(deps, request.providerTeamId),
    ]);
    const ranked = rankOptions(await deps.store.listOptions(requestId));
    if (ranked.length === 0) throw new NegotiationError(`No options stored for ${requestId}`);
    const recommended = ranked[0];
    output = await runRound(deps, requestId, 2, 'broker', { optionCount: ranked.length }, async () => {
      await deps.store.setRecommended(requestId, recommended.id);
      await commentOnce(
        deps,
        requestId,
        `comment:deal-sheet:${request.sourceIssueKey}`,
        request.sourceIssueKey,
        `Accord: the deal sheet for "${request.title}" (${provider.name}) is ready with ${ranked.length} options. ` +
          `Recommended delivery ${recommended.dateRange.min || 'none'} to ${recommended.dateRange.max || 'none'}. ` +
          'Nothing changes in Jira until both team leads approve the same option in the Accord panel.',
      );
      const shiftedKeys = [...new Set(recommended.shifted.map((item) => item.key))];
      for (const key of shiftedKeys) {
        await commentOnce(
          deps,
          requestId,
          `comment:deal-sheet:${key}`,
          key,
          `Accord: the recommended option for ${requester.name}'s request "${request.title}" (${request.sourceIssueKey}) ` +
            `would move this issue to a later sprint. It only moves if the ${provider.name} and ${requester.name} leads both approve.`,
        );
      }
      return { rankedOptionIds: ranked.map((option) => option.id), recommendedOptionId: recommended.id };
    });
  }
  if (await deps.store.transition(requestId, ['negotiating'], 'awaiting-approval')) {
    await deps.store.audit('request', requestId, 'deal-sheet-ready', null, output);
  }
  return { status: 'done', detail: `${output.rankedOptionIds.length} options, recommended ${output.recommendedOptionId}` };
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
  const reason = input.reason?.trim().slice(0, 1000) || null;
  const approval = { requestId: request.id, optionId: input.optionId, teamId, actorAccountId: input.accountId, decision: input.decision, reason };

  if (input.decision === 'reject') {
    if (!reason) throw new NegotiationError('A reason is required to reject.');
    if (!(await deps.store.transition(request.id, ['awaiting-approval'], 'rejected'))) {
      throw changedMeanwhile((await deps.store.getRequest(request.id))?.status);
    }
    await deps.store.addApproval(approval, 'rejected');
    await deps.store.audit('request', request.id, 'rejected', input.accountId, { optionId: input.optionId, teamId, side: input.side, reason });
    return { status: 'rejected', detail: reason };
  }

  const otherTeamId = input.side === 'requester' ? request.providerTeamId : request.requesterTeamId;
  if (!deps.allowSameApprover) {
    const before = approvalState(await deps.store.listApprovals(request.id), request.requesterTeamId, request.providerTeamId);
    const other = otherTeamId === request.requesterTeamId ? before.requester : before.provider;
    if (other?.decision === 'approve' && other.actorAccountId === input.accountId) {
      await deps.store.audit('request', request.id, 'decision-denied', input.accountId, { side: input.side, teamId, rule: 'dual-control' });
      throw new NegotiationError('Dual control: you already approved for the other team, so another lead must approve for this team.');
    }
  }

  if (!(await deps.store.addApproval(approval, 'awaiting-approval'))) {
    throw changedMeanwhile((await deps.store.getRequest(request.id))?.status);
  }
  await deps.store.audit('request', request.id, 'approved', input.accountId, { optionId: input.optionId, teamId, side: input.side });

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

  const deliverable = await ensureDeliverable(deps, request, provider, contract, dates.max);

  if (!(await deps.jira.hasBlocksLink(deliverable, request.sourceIssueKey))) {
    await deps.jira.linkBlocks(deliverable, request.sourceIssueKey);
    await deps.store.audit('contract', String(contract.id), 'link-created', null, {
      blocker: deliverable,
      blocked: request.sourceIssueKey,
      ...actor,
    });
  }

  if (option.shifted.length > 0 && !(await deps.store.hasStep(requestId, 'contract:shift'))) {
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

  const agreed = `${dates.min} to ${dates.max}`;
  await commentOnce(
    deps,
    requestId,
    `comment:contract:${request.sourceIssueKey}`,
    request.sourceIssueKey,
    `Accord contract: ${provider.name} delivers "${request.title}" as ${deliverable}, agreed ${agreed}. ` +
      `Approved by the ${requester.name} and ${provider.name} leads.`,
  );
  await commentOnce(
    deps,
    requestId,
    `comment:contract:${deliverable}`,
    deliverable,
    `Accord contract with ${requester.name} (${request.sourceIssueKey}): agreed delivery ${agreed}.` +
      (option.shifted.length ? ` Moved to make room: ${option.shifted.map((item) => item.key).join(', ')}.` : ''),
  );

  await deps.store.ensureEdge(contract.id, request.requesterTeamId, request.providerTeamId);
  await deps.store.setContractStatus(requestId, 'on-track');
  if (await deps.store.transition(requestId, ['approved'], 'contracted')) {
    await deps.store.audit('contract', String(contract.id), 'contract-applied', null, {
      requestId,
      optionId: option.id,
      deliverable,
      agreed: dates,
      ...actor,
    });
  }
  return { status: 'done', detail: `contract ${contract.id}, deliverable ${deliverable}` };
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
  createdBy: string;
}

const SIZES: readonly Size[] = ['S', 'M', 'L'];
export const COST_CLASSES: readonly CostClass[] = ['fixed-date', 'standard', 'intangible'];

export function validateNewRequest(input: Omit<NewRequestInput, 'requesterTeam' | 'providerTeam'>, today: string): string | null {
  if (!input.title.trim() || input.title.length > 255) return 'Title is required (at most 255 characters).';
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
    title: input.title.trim(),
    size: input.size,
    minSize: input.minSize,
    neededBy: input.neededBy,
    costClass: input.costClass,
    status: 'negotiating',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await deps.store.insertRequest(request);
  await deps.store.audit('request', id, 'created', input.createdBy, {
    sourceIssueKey: request.sourceIssueKey,
    provider: input.providerTeam.teamKey,
    size: request.size,
    minSize: request.minSize,
    neededBy: request.neededBy,
  });
  try {
    await deps.queue.push({ type: 'round1', requestId: id });
  } catch (pushError) {
    const message = pushError instanceof Error ? pushError.message : String(pushError);
    await deps.store.transition(id, ['negotiating'], 'failed');
    await deps.store.audit('request', id, 'round1-enqueue-failed', null, { error: message.slice(0, 1000) });
    throw new NegotiationError('The request was saved but the negotiation could not be started, so it is marked failed. Use "Retry negotiation".');
  }
  return request;
}
