import { projectContract, type CapacityRange, type IsoDate, type ProjectionInput, type Size, type Sprint, type WorkItem } from '../planner';
import { quotedTitle } from '../negotiation/orchestrator';
import type { Contract, ContractStatus, DependencyRequest } from '../negotiation/types';
import type { Team } from '../teams/repository';

export const MONITOR_QUEUE_KEY = 'accord-monitor';

export type MonitorEvent = { type: 'monitor-team'; teamId: string };

/** Contract statuses the monitor evaluates (`applying` contracts are still being written to Jira). */
export const MONITORED_STATUSES: readonly ContractStatus[] = ['on-track', 'at-risk', 'unknown'];

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
}

const APP_ACTOR_REASON = 'Daily contract monitor; runs as the app without a user context.';

const orderContracts = (a: MonitoredContract, b: MonitoredContract) =>
  a.contract.agreedDateMax.localeCompare(b.contract.agreedDateMax) || a.contract.id - b.contract.id;

export type CommentAudience = 'requester' | 'provider';

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
): string {
  const link = `${request.sourceIssueKey} → ${contract.deliverableIssueKey ?? 'deliverable pending'}`;
  const projected = evaluation.projectedDate ?? 'beyond the planning horizon';
  const agreed = `${contract.agreedDateMin} to ${contract.agreedDateMax}`;
  const subject = `the contract for ${quotedTitle(request.title)} (${link})`;
  if (evaluation.to === 'at-risk') {
    const workload =
      audience === 'provider'
        ? ` ${evaluation.workAhead} issues are planned ahead of and including this work at a pessimistic ${pessimistic} issues per sprint.`
        : '';
    return (
      `Accord monitor: ${subject} is now at risk. Projected delivery is ${projected}; the agreed range is ${agreed}.` +
      `${workload} Both teams may want to review the plan together.`
    );
  }
  return `Accord monitor: ${subject} is back on track. Projected delivery is ${projected}, within the agreed range ${agreed}.`;
}

/** Monitored contracts of a provider plus the capacity and commitments every evaluation uses. */
async function loadProviderPlanning(deps: Pick<MonitorDeps, 'store' | 'teams' | 'jira'>, teamId: string) {
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
  };
  const loaded = await loadProviderPlanning(deps, teamId);
  if (!loaded) return result;
  const { team, contracts, capacity, planning, done, enoughData, committedIssues } = loaded;
  result.pessimistic = capacity.pessimistic;
  result.committedIssues = committedIssues;
  result.enoughData = enoughData;

  const earlier: Size[] = [];
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
    result.comments.push(...(await notifyStatus(deps, team, contract, request, evaluation, capacity.pessimistic)));
  }
  return result;
}

/** At most one comment per announced status change and issue (atomic claim before posting). */
async function notifyStatus(
  deps: MonitorDeps,
  provider: Team,
  contract: Contract,
  request: DependencyRequest,
  evaluation: ContractEvaluation,
  pessimistic: number,
): Promise<string[]> {
  if (!ANNOUNCED_STATUSES.includes(evaluation.to)) return [];
  const last = await deps.store.lastNotification(contract.id);
  let seq: number;
  let claimed: ReadonlySet<string>;
  if (last && last.status === evaluation.to) {
    // Same change as the last announcement: only finish issues that were never claimed.
    seq = last.seq;
    claimed = new Set(last.issueKeys);
  } else if (!last && evaluation.to === INITIAL_ANNOUNCED_STATUS) {
    return [];
  } else {
    seq = (last?.seq ?? 0) + 1;
    claimed = new Set();
  }
  const targets: Array<{ issueKey: string; audience: CommentAudience }> = [
    { issueKey: request.sourceIssueKey, audience: 'requester' },
    ...(contract.deliverableIssueKey && contract.deliverableIssueKey !== request.sourceIssueKey
      ? [{ issueKey: contract.deliverableIssueKey, audience: 'provider' as const }]
      : []),
  ];
  const pending = targets.filter((target) => !claimed.has(target.issueKey));
  if (pending.length === 0) return [];
  const requester = await deps.teams.getTeam(request.requesterTeamId);
  const mentions = [
    ...new Set([...(requester ? await deps.teams.approvers(requester) : []), ...(await deps.teams.approvers(provider))]),
  ];
  const entityId = String(contract.id);
  const posted: string[] = [];
  for (const { issueKey, audience } of pending) {
    if (!(await deps.store.claimNotification(contract.id, seq, evaluation.to, evaluation.projectedDate, issueKey))) continue;
    const step = `notify:${seq}:${issueKey}`;
    await deps.store.audit('contract', entityId, step, null, { issueKey, status: evaluation.to, as: 'app', reason: APP_ACTOR_REASON });
    try {
      await deps.jira.addComment(issueKey, statusComment(audience, request, contract, evaluation, pessimistic), mentions);
      posted.push(issueKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Accord monitor comment on ${issueKey} for contract ${entityId} failed`, message);
      await deps.store.audit('contract', entityId, 'comment-failed', null, { step, issueKey, error: message.slice(0, 500) });
    }
  }
  return posted;
}
