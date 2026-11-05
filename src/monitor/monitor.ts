import {
  projectContract,
  SIZE_ISSUES,
  type CapacityRange,
  type IsoDate,
  type ProjectionInput,
  type Size,
  type Sprint,
  type WorkItem,
} from '../planner';
import { pickActiveAndNext } from '../capacity/aggregate';
import { formatDate, formatDateRange } from '../format/dates';
import { plural } from '../format/text';
import {
  quotedTitle,
  type BackOnTrackCancellation,
  type RenegotiationResult,
  type RenegotiationTrigger,
} from '../negotiation/orchestrator';
import type { Contract, ContractStatus, DependencyRequest, RenegotiationWorkAhead } from '../negotiation/types';
import type { Team } from '../teams/repository';

export const MONITOR_QUEUE_KEY = 'accord-monitor';

export type MonitorEvent = { type: 'monitor-team'; teamId: string };

/** Contract statuses the monitor evaluates (`applying` contracts are still being written to Jira). */
export const MONITORED_STATUSES: readonly ContractStatus[] = ['on-track', 'at-risk', 'unknown'];

/** New renegotiations one monitor run opens per provider team (FR-14); the rest wait for the next run. */
export const MAX_RENEGOTIATIONS_PER_RUN = 2;

/** Statuses announced in Jira; `unknown` (no capacity data) stays silent. */
const ANNOUNCED_STATUSES: readonly ContractStatus[] = ['on-track', 'at-risk'];

/** A new contract was announced as on track by the apply-contract comments. */
const INITIAL_ANNOUNCED_STATUS: ContractStatus = 'on-track';

export interface MonitoredContract {
  contract: Contract;
  request: DependencyRequest;
}

/** Latest announced status change of a contract and the issues already claimed for it. */
export interface NotificationState {
  seq: number;
  status: ContractStatus;
  issueKeys: string[];
}

export interface MonitorStore {
  /** Provider team ids that have at least one monitored contract. */
  providersWithContracts(): Promise<string[]>;
  /** All monitored contracts where `providerTeamId` is the provider (no limit). */
  contractsForProvider(providerTeamId: string): Promise<MonitoredContract[]>;
  /**
   * Sets status `to`, projected date and evaluation time only while the status is still `from`
   * (conditional UPDATE); returns false when another run changed the status first.
   */
  saveEvaluation(contractId: number, from: ContractStatus, to: ContractStatus, projectedDate: IsoDate | null): Promise<boolean>;
  lastNotification(contractId: number): Promise<NotificationState | null>;
  /** Atomic claim of one comment (unique contract + seq + issue); false when it was claimed before. */
  claimNotification(contractId: number, seq: number, status: ContractStatus, projectedDate: IsoDate | null, issueKey: string): Promise<boolean>;
  /**
   * For a contract that came out of a renegotiation (its request id): the projected date of the contract it
   * replaced, as last evaluated. Null when the request is no renegotiation.
   */
  renegotiationBaseline(requestId: string): Promise<{ projectedDate: IsoDate | null } | null>;
  audit(entityType: string, entityId: string, action: string, actor: string | null, payload: unknown): Promise<void>;
}

export interface MonitorTeams {
  getTeam(teamId: string): Promise<Team | null>;
  capacity(team: Team): Promise<CapacityRange & { source?: string }>;
  /** Charter approvers plus the Jira project lead. */
  approvers(team: Team): Promise<string[]>;
}

export interface MonitorJira {
  /** Provider sprints and open committed issues of the active and next sprint. */
  commitments(team: Team): Promise<{ sprints: Sprint[]; commitments: WorkItem[] }>;
  /** Subset of `issueKeys` whose status category is Done. */
  doneIssueKeys(issueKeys: readonly string[]): Promise<Set<string>>;
  addComment(issueKey: string, text: string, mentions: readonly string[]): Promise<void>;
}

export interface MonitorDeps {
  store: MonitorStore;
  teams: MonitorTeams;
  jira: MonitorJira;
  today: () => IsoDate;
  /** Opens (idempotently) the renegotiation of an at-risk contract (FR-14). */
  renegotiate(trigger: RenegotiationTrigger): Promise<RenegotiationResult>;
  /** Withdraws the undecided renegotiations of a contract that is back on track (idempotent). */
  cancelRenegotiations(contract: Contract, request: DependencyRequest): Promise<BackOnTrackCancellation>;
}

export interface ContractEvaluation {
  contractId: number;
  requestId: string;
  deliverableIssueKey: string | null;
  from: ContractStatus;
  to: ContractStatus;
  projectedDate: IsoDate | null;
  agreedDateMax: IsoDate;
  workAhead: number;
  changed: boolean;
}

export interface MonitorTeamResult {
  teamId: string;
  pessimistic: number | null;
  committedIssues: number | null;
  /** False when the provider has no capacity data: contracts become `unknown`, nothing is posted. */
  enoughData: boolean;
  evaluated: ContractEvaluation[];
  skippedDone: number[];
  comments: string[];
  /** `deferred`: left for a later run because this run already opened MAX_RENEGOTIATIONS_PER_RUN. */
  renegotiations: Array<MonitorRenegotiation & { contractId: number }>;
  /** At-risk contracts of an applied renegotiation whose projection is not worse than before it (no new one). */
  held: number[];
  /** Renegotiations withdrawn because their contract is back on track. */
  cancelledRenegotiations: string[];
}

const APP_ACTOR_REASON = 'Daily contract monitor; runs as the app without a user context.';

const orderContracts = (a: MonitoredContract, b: MonitoredContract) =>
  a.contract.agreedDateMax.localeCompare(b.contract.agreedDateMax) || a.contract.id - b.contract.id;

export type CommentAudience = 'requester' | 'provider';

/** Outcome of the renegotiation step for one at-risk contract in this run. */
export type MonitorRenegotiation = RenegotiationResult | { status: 'deferred'; requestId: null; detail: string };

/** One at-risk comment also says what happened to the renegotiation (FR-14), instead of a second comment. */
function renegotiationSentence(renegotiation: MonitorRenegotiation | null): string | null {
  if (renegotiation?.status === 'opened') {
    return 'Accord opened a renegotiation: both team leads find the new deal sheet in the Accord panel. The current contract stays in effect until both approve a new option.';
  }
  if (renegotiation?.status === 'exists' && renegotiation.requestId) {
    return 'A renegotiation of this contract is already open in the Accord panel; the current contract stays in effect until both team leads approve a new option.';
  }
  if (renegotiation?.status === 'deferred') return 'Accord opens a renegotiation on the next monitor run.';
  return null;
}

/**
 * Neutral status comment. The requester's source issue only gets the projected date and the agreed
 * range; the provider's internal workload (work ahead, capacity) stays on the provider's deliverable.
 */
export function statusComment(
  audience: CommentAudience,
  request: DependencyRequest,
  contract: Contract,
  evaluation: ContractEvaluation,
  pessimistic: number,
  renegotiation: MonitorRenegotiation | null = null,
  renegotiationCancelled = false,
): string {
  const link = `${request.sourceIssueKey} → ${contract.deliverableIssueKey ?? 'deliverable pending'}`;
  const projected = formatDate(evaluation.projectedDate, 'beyond the planning horizon');
  const agreedKind = contract.agreedDateMin === contract.agreedDateMax ? 'date' : 'range';
  const agreedDates = formatDateRange(contract.agreedDateMin, contract.agreedDateMax);
  const subject = `the contract for ${quotedTitle(request.title)} (${link})`;
  if (evaluation.to === 'at-risk') {
    const workload =
      audience === 'provider'
        ? ` ${plural(evaluation.workAhead, 'issue')} ${evaluation.workAhead === 1 ? 'is' : 'are'} planned ahead of and including this work at a pessimistic ${plural(pessimistic, 'issue')} per sprint.`
        : '';
    return (
      `Accord monitor: ${subject} is now at risk. Projected delivery is ${projected}; the agreed ${agreedKind} is ${agreedDates}.` +
      `${workload} ${renegotiationSentence(renegotiation) ?? 'Both teams may want to review the plan together.'}`
    );
  }
  const withdrawn = renegotiationCancelled
    ? ' The open renegotiation is no longer needed and was cancelled; the current contract stays in effect.'
    : '';
  return `Accord monitor: ${subject} is back on track. Projected delivery is ${projected}, within the agreed ${agreedKind} ${agreedDates}.${withdrawn}`;
}

/** Monitored contracts of a provider plus the capacity and commitments every evaluation uses. */
/** What loading a provider's planning needs (also used by the negotiation side for renegotiations). */
export interface ProviderPlanningDeps {
  store: Pick<MonitorStore, 'contractsForProvider'>;
  teams: Pick<MonitorTeams, 'getTeam' | 'capacity'>;
  jira: Pick<MonitorJira, 'commitments' | 'doneIssueKeys'>;
}

async function loadProviderPlanning(deps: ProviderPlanningDeps, teamId: string) {
  const team = await deps.teams.getTeam(teamId);
  if (!team) throw new Error(`Provider team ${teamId} is not registered`);
  const contracts = (await deps.store.contractsForProvider(teamId))
    .filter((row) => MONITORED_STATUSES.includes(row.contract.status))
    .sort(orderContracts);
  if (contracts.length === 0) return null;

  const deliverables = contracts.map((row) => row.contract.deliverableIssueKey).filter((key): key is string => key !== null);
  const [capacity, planning, done] = [
    await deps.teams.capacity(team),
    await deps.jira.commitments(team),
    await deps.jira.doneIssueKeys(deliverables),
  ];
  const enoughData = capacity.source !== 'none' && Number.isFinite(capacity.pessimistic) && capacity.pessimistic > 0;
  const deliverableSet = new Set(deliverables);
  // Every open issue of the active and next sprint counts as work ahead of a deliverable, wherever the
  // deliverable sits (active sprint, next sprint or backlog).
  const committedIssues = planning.commitments
    .filter((item) => !deliverableSet.has(item.key))
    .reduce((sum, item) => sum + (item.size ?? 1), 0);
  return { team, contracts, capacity, planning, done, enoughData, committedIssues };
}

/** Work ahead of a re-planned contract under the monitor rule (FR-14, NFR-1): input of PlannerInput.workAhead. */
export type ProviderWorkAhead = RenegotiationWorkAhead;

/**
 * Work the provider finishes before `contractId` when that contract is placed after every other open
 * contract (the latest position a renegotiated date can take), so a date the planner offers on this basis
 * is never projected as missed by the monitor on the same data. Null without capacity data.
 */
export async function providerWorkAhead(
  deps: Pick<MonitorDeps, 'store' | 'teams' | 'jira'>,
  teamId: string,
  contractId: number,
): Promise<ProviderWorkAhead | null> {
  const loaded = await loadProviderPlanning(deps, teamId);
  if (!loaded || !loaded.enoughData) return null;
  const { contracts, capacity, planning, done, committedIssues } = loaded;
  const deliverables = new Set(contracts.map((row) => row.contract.deliverableIssueKey));
  const others = contracts.filter(
    ({ contract }) => contract.id !== contractId && !(contract.deliverableIssueKey && done.has(contract.deliverableIssueKey)),
  );
  const counted = planning.commitments.filter((item) => !deliverables.has(item.key));
  const contractIssues = others.reduce((sum, row) => sum + SIZE_ISSUES[row.request.size], 0);
  return {
    pessimistic: capacity.pessimistic,
    committedIssues,
    contractIssues,
    issues: committedIssues + contractIssues,
    countedKeys: counted.map((item) => item.key),
    countedSprintIds: pickActiveAndNext(planning.sprints).map((sprint) => sprint.id),
    pinnedKeys: others.map((row) => row.contract.deliverableIssueKey).filter((key): key is string => key !== null),
    criticalBugs: counted.filter((item) => item.issueType.toLowerCase() === 'bug' && item.priority.toLowerCase() === 'highest').length,
  };
}

/** Projection input of the open contract with the earliest agreed date, exactly as the monitor would evaluate it. */
export interface NearestContractProjection {
  contractId: number;
  deliverableIssueKey: string | null;
  status: ContractStatus;
  /** Open committed issues of the provider and their keys (deliverables excluded). */
  committedKeys: string[];
  input: ProjectionInput;
}

export async function nearestContractProjection(
  deps: Pick<MonitorDeps, 'store' | 'teams' | 'jira' | 'today'>,
  teamId: string,
): Promise<NearestContractProjection | null> {
  const loaded = await loadProviderPlanning(deps, teamId);
  if (!loaded || !loaded.enoughData) return null;
  const { contracts, capacity, planning, done, committedIssues } = loaded;
  const deliverables = new Set(contracts.map((row) => row.contract.deliverableIssueKey));
  const open = contracts.find(({ contract }) => !(contract.deliverableIssueKey && done.has(contract.deliverableIssueKey)));
  if (!open) return null;
  return {
    contractId: open.contract.id,
    deliverableIssueKey: open.contract.deliverableIssueKey,
    status: open.contract.status,
    committedKeys: planning.commitments.filter((item) => !deliverables.has(item.key)).map((item) => item.key),
    input: {
      sprints: planning.sprints,
      today: deps.today(),
      pessimistic: capacity.pessimistic,
      committedIssues,
      earlierContractSizes: [],
      size: open.request.size,
      agreedDateMax: open.contract.agreedDateMax,
    },
  };
}

/**
 * Re-evaluates every monitored contract of one provider team, in agreed-date order:
 * work ahead = open sprint commitments (deliverables excluded) + earlier contracts + this one.
 * Without capacity data the contracts become `unknown` (silent). Notifications compare the
 * evaluated status with the last announced one (marker table), so a crash between the status
 * update and the comments still yields exactly one comment per change and issue.
 */
export async function monitorProviderTeam(deps: MonitorDeps, teamId: string): Promise<MonitorTeamResult> {
  const result: MonitorTeamResult = {
    teamId,
    pessimistic: null,
    committedIssues: null,
    enoughData: true,
    evaluated: [],
    skippedDone: [],
    comments: [],
    renegotiations: [],
    held: [],
    cancelledRenegotiations: [],
  };
  const loaded = await loadProviderPlanning(deps, teamId);
  if (!loaded) return result;
  const { team, contracts, capacity, planning, done, enoughData, committedIssues } = loaded;
  result.pessimistic = capacity.pessimistic;
  result.committedIssues = committedIssues;
  result.enoughData = enoughData;

  const earlier: Size[] = [];
  const atRisk: Array<{ contract: Contract; request: DependencyRequest; evaluation: ContractEvaluation }> = [];
  for (const { contract, request } of contracts) {
    if (contract.deliverableIssueKey && done.has(contract.deliverableIssueKey)) {
      result.skippedDone.push(contract.id);
      continue;
    }
    const projection = projectContract({
      sprints: planning.sprints,
      today: deps.today(),
      pessimistic: enoughData ? capacity.pessimistic : 0,
      committedIssues,
      earlierContractSizes: earlier,
      size: request.size,
      agreedDateMax: contract.agreedDateMax,
    });
    earlier.push(request.size);
    const to: ContractStatus = enoughData ? projection.status : 'unknown';
    const projectedDate = enoughData ? projection.projectedDate : null;
    const saved = await deps.store.saveEvaluation(contract.id, contract.status, to, projectedDate);
    const changed = saved && to !== contract.status;
    const evaluation: ContractEvaluation = {
      contractId: contract.id,
      requestId: request.id,
      deliverableIssueKey: contract.deliverableIssueKey,
      from: contract.status,
      to,
      projectedDate,
      agreedDateMax: contract.agreedDateMax,
      workAhead: projection.workAhead,
      changed,
    };
    result.evaluated.push(evaluation);
    if (changed) {
      await deps.store.audit('contract', String(contract.id), 'status-changed', null, {
        requestId: request.id,
        from: contract.status,
        to,
        projectedDate,
        agreedDateMax: contract.agreedDateMax,
        workAhead: projection.workAhead,
        pessimistic: capacity.pessimistic,
        as: 'app',
      });
    }
    // Another run moved the status first: it owns this change (and its notifications).
    if (to !== contract.status && !saved) continue;
    if (to === 'at-risk') {
      if (await heldAfterRenegotiation(deps, contract, request, evaluation)) {
        result.held.push(contract.id);
        continue;
      }
      atRisk.push({ contract, request, evaluation });
      continue;
    }
    const claim = await claimStatus(deps, contract, request, evaluation);
    const withdrawn = to === 'on-track' ? await cancelBackOnTrack(deps, contract, request) : null;
    if (withdrawn) result.cancelledRenegotiations.push(...withdrawn.cancelled);
    // Only a renegotiation announced on the source issue gets a sentence there, inside the on-track comment.
    const cancelledNote = withdrawn !== null && withdrawn.announced && withdrawn.cancelled.length > 0;
    result.comments.push(
      ...(await postStatus(deps, team, contract, request, evaluation, capacity.pessimistic, claim, null, cancelledNote)),
    );
  }
  // At most MAX_RENEGOTIATIONS_PER_RUN new renegotiations per provider and run, nearest agreed date first;
  // the rest open on a later run (the opener is idempotent per contract and episode). The at-risk comment is
  // claimed first (its seq is the episode) and posted after, so it also tells what happened to the renegotiation.
  atRisk.sort((a, b) => a.contract.agreedDateMax.localeCompare(b.contract.agreedDateMax) || a.contract.id - b.contract.id);
  let opened = 0;
  for (const { contract, request, evaluation } of atRisk) {
    const claim = await claimStatus(deps, contract, request, evaluation);
    let renegotiation: MonitorRenegotiation | null;
    if (opened >= MAX_RENEGOTIATIONS_PER_RUN) {
      renegotiation = { status: 'deferred', requestId: null, detail: 'renegotiation limit for this run reached' };
    } else {
      const announced = claim?.targets.some((target) => target.issueKey === request.sourceIssueKey) ?? false;
      renegotiation = await renegotiateAtRisk(deps, contract, request, evaluation.projectedDate, announced);
      if (renegotiation?.status === 'opened') opened += 1;
    }
    if (renegotiation) result.renegotiations.push({ ...renegotiation, contractId: contract.id });
    result.comments.push(...(await postStatus(deps, team, contract, request, evaluation, capacity.pessimistic, claim, renegotiation)));
  }
  return result;
}

/**
 * Guard after a renegotiation (FR-14): the contract it applied is not renegotiated again, and not announced
 * as at risk again, while its projection is no worse than that of the contract it replaced. Only new data
 * (a later projected date) opens the next episode. The status itself is saved, so the UI stays truthful.
 */
async function heldAfterRenegotiation(
  deps: MonitorDeps,
  contract: Contract,
  request: DependencyRequest,
  evaluation: ContractEvaluation,
): Promise<boolean> {
  const last = await deps.store.lastNotification(contract.id);
  // Already announced (an earlier, worse projection): the episode continues as usual.
  if (last?.status === 'at-risk') return false;
  // Only the data the renegotiation was agreed on is held: the first evaluation after apply (no projected
  // date yet), or a contract this guard already held. One that was on track since then is at risk from new data.
  const sameData = (contract.status === 'on-track' && contract.projectedDate === null) || contract.status === 'at-risk';
  if (!sameData) return false;
  const baseline = await deps.store.renegotiationBaseline(request.id);
  if (!baseline) return false;
  const worse =
    baseline.projectedDate !== null && (evaluation.projectedDate === null || evaluation.projectedDate > baseline.projectedDate);
  if (worse) return false;
  if (evaluation.changed) {
    await deps.store.audit('contract', String(contract.id), 'renegotiation-held', null, {
      requestId: request.id,
      projectedDate: evaluation.projectedDate,
      baselineProjectedDate: baseline.projectedDate,
      as: 'app',
      reason: APP_ACTOR_REASON,
    });
  }
  return true;
}

/**
 * FR-14: an at-risk contract gets one renegotiation per at-risk episode (the seq of its at-risk announcement).
 * Runs on every at-risk evaluation, so a crash after the status change is finished by the next run; the
 * opener itself is idempotent. Failures are audited and never stop the monitor.
 */
async function renegotiateAtRisk(
  deps: MonitorDeps,
  contract: Contract,
  request: DependencyRequest,
  projectedDate: IsoDate | null,
  announced: boolean,
): Promise<RenegotiationResult | null> {
  try {
    const last = await deps.store.lastNotification(contract.id);
    if (!last || last.status !== 'at-risk') return null;
    return await deps.renegotiate({
      contract: { ...contract, status: 'at-risk', projectedDate },
      request,
      projectedDate,
      episode: last.seq,
      announcedByMonitor: announced,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Accord renegotiation for contract ${contract.id} failed`, message);
    await deps.store.audit('contract', String(contract.id), 'renegotiation-failed', null, { error: message.slice(0, 500), as: 'app' });
    return { status: 'skipped', requestId: null, detail: message.slice(0, 200) };
  }
}

/**
 * The contract is on track again (FR-14): its undecided renegotiations are withdrawn. Runs on every on-track
 * evaluation, so a crash is finished by the next run. Failures are audited and never stop the monitor.
 */
async function cancelBackOnTrack(
  deps: MonitorDeps,
  contract: Contract,
  request: DependencyRequest,
): Promise<BackOnTrackCancellation | null> {
  try {
    return await deps.cancelRenegotiations(contract, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Accord renegotiation cancel for contract ${contract.id} failed`, message);
    await deps.store.audit('contract', String(contract.id), 'renegotiation-cancel-failed', null, { error: message.slice(0, 500), as: 'app' });
    return null;
  }
}

interface StatusClaim {
  seq: number;
  /** Issues claimed by this run for this announcement (each gets exactly one comment). */
  targets: Array<{ issueKey: string; audience: CommentAudience }>;
}

/**
 * Claims the comments of one announced status change (atomic per contract, seq and issue), before anything
 * is posted; null when nothing is left to announce. A repeated status never gets a second comment.
 */
async function claimStatus(
  deps: MonitorDeps,
  contract: Contract,
  request: DependencyRequest,
  evaluation: ContractEvaluation,
): Promise<StatusClaim | null> {
  if (!ANNOUNCED_STATUSES.includes(evaluation.to)) return null;
  const last = await deps.store.lastNotification(contract.id);
  let seq: number;
  let claimed: ReadonlySet<string>;
  if (last && last.status === evaluation.to) {
    // Same change as the last announcement: only finish issues that were never claimed.
    seq = last.seq;
    claimed = new Set(last.issueKeys);
  } else if (!last && evaluation.to === INITIAL_ANNOUNCED_STATUS) {
    return null;
  } else {
    seq = (last?.seq ?? 0) + 1;
    claimed = new Set();
  }
  const all: StatusClaim['targets'] = [
    { issueKey: request.sourceIssueKey, audience: 'requester' },
    ...(contract.deliverableIssueKey && contract.deliverableIssueKey !== request.sourceIssueKey
      ? [{ issueKey: contract.deliverableIssueKey, audience: 'provider' as const }]
      : []),
  ];
  const targets: StatusClaim['targets'] = [];
  for (const target of all.filter((item) => !claimed.has(item.issueKey))) {
    if (!(await deps.store.claimNotification(contract.id, seq, evaluation.to, evaluation.projectedDate, target.issueKey))) continue;
    targets.push(target);
  }
  return targets.length > 0 ? { seq, targets } : null;
}

/** Posts the claimed comments: one per announced status change and issue. */
async function postStatus(
  deps: MonitorDeps,
  provider: Team,
  contract: Contract,
  request: DependencyRequest,
  evaluation: ContractEvaluation,
  pessimistic: number,
  claim: StatusClaim | null,
  renegotiation: MonitorRenegotiation | null,
  renegotiationCancelled = false,
): Promise<string[]> {
  if (!claim) return [];
  const { seq, targets } = claim;
  const requester = await deps.teams.getTeam(request.requesterTeamId);
  const mentions = [
    ...new Set([...(requester ? await deps.teams.approvers(requester) : []), ...(await deps.teams.approvers(provider))]),
  ];
  const entityId = String(contract.id);
  const posted: string[] = [];
  for (const { issueKey, audience } of targets) {
    const step = `notify:${seq}:${issueKey}`;
    await deps.store.audit('contract', entityId, step, null, { issueKey, status: evaluation.to, as: 'app', reason: APP_ACTOR_REASON });
    try {
      const cancelled = renegotiationCancelled && audience === 'requester';
      await deps.jira.addComment(issueKey, statusComment(audience, request, contract, evaluation, pessimistic, renegotiation, cancelled), mentions);
      posted.push(issueKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Accord monitor comment on ${issueKey} for contract ${entityId} failed`, message);
      await deps.store.audit('contract', entityId, 'comment-failed', null, { step, issueKey, error: message.slice(0, 500) });
    }
  }
  return posted;
}
