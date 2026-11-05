import type {
  CapacityRange,
  Charter,
  CostClass,
  DateRange,
  IsoDate,
  OptionKind,
  PlannerWorkAhead,
  ShiftedItem,
  Size,
  Sprint,
  TraceStep,
  WorkItem,
} from '../planner';
import type { Team } from '../teams/repository';
import type { JiraPermission } from '../jira/permissions';

/**
 * Lifecycle of a dependency request (PRD: Negotiating → Awaiting approval → Contracted).
 * `cancelled`: an open renegotiation withdrawn before a decision (demo reset), kept for the audit trail.
 */
export type RequestStatus = 'negotiating' | 'awaiting-approval' | 'approved' | 'contracted' | 'rejected' | 'failed' | 'cancelled';

/** Creator id of requests Accord opens itself (renegotiations, FR-14); never a Jira account id. */
export const APP_CREATOR = 'app';

export interface DependencyRequest {
  id: string;
  requesterTeamId: string;
  providerTeamId: string;
  sourceIssueKey: string;
  title: string;
  size: Size;
  minSize: number | null;
  neededBy: IsoDate;
  costClass: CostClass;
  status: RequestStatus;
  createdBy: string;
  createdAt: string;
}

export type RoundRole = 'provider-delegate' | 'requester-delegate' | 'broker';
export type RoundStatus = 'running' | 'done' | 'failed';

export interface RoundRecord {
  id: number;
  requestId: string;
  roundNo: 1 | 2;
  role: RoundRole;
  input: unknown;
  output: unknown;
  status: RoundStatus;
  error: string | null;
  createdAt: string;
}

export interface StoredOption {
  id: number;
  requestId: string;
  roundId: number | null;
  kind: OptionKind;
  dateRange: DateRange;
  shifted: ShiftedItem[];
  rulesUsed: string[];
  trace: TraceStep[];
  meetsNeed: boolean;
  shiftCost: number;
  recommended: boolean;
}

export type Decision = 'approve' | 'reject';

export interface Approval {
  id: number;
  requestId: string;
  optionId: number;
  teamId: string;
  actorAccountId: string;
  decision: Decision;
  reason: string | null;
  createdAt: string;
}

/**
 * `unknown`: the provider has no usable capacity data, so the monitor cannot project a date.
 * `superseded`: replaced by the contract of an applied renegotiation (kept, no longer monitored).
 */
export type ContractStatus = 'applying' | 'on-track' | 'at-risk' | 'unknown' | 'superseded';

/** Renegotiation request opened for an at-risk contract (FR-14); one per contract and at-risk episode. */
export interface Renegotiation {
  requestId: string;
  parentRequestId: string;
  contractId: number;
  /** Notification sequence of the at-risk announcement that opened it. */
  episode: number;
}

/** Statuses of a renegotiation that still block opening another one for the same contract. */
export const OPEN_RENEGOTIATION_STATUSES: readonly RequestStatus[] = ['negotiating', 'awaiting-approval', 'approved'];

/** Audit step (entity `contract`) written when apply-contract created the blocks link itself. */
export const LINK_CREATED_STEP = 'link-created';

/** Requests that block a duplicate for the same source issue and provider. */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ['negotiating', 'awaiting-approval'];

/** `exists`: a request with this id is already stored (a parallel attempt with the same id won). */
export type InsertRequestResult = 'inserted' | 'exists' | 'duplicate' | 'provider-limit';

export interface Contract {
  id: number;
  requestId: string;
  optionId: number;
  deliverableIssueKey: string | null;
  agreedDateMin: IsoDate;
  agreedDateMax: IsoDate;
  status: ContractStatus;
  projectedDate: IsoDate | null;
}

/** Jobs on the `accord-negotiation` queue; one job per round / apply step (NFR-5). */
export type NegotiationEvent =
  | { type: 'round1'; requestId: string }
  | { type: 'round2'; requestId: string }
  | { type: 'apply-contract'; requestId: string };

export interface PlanningContext {
  charter: Charter;
  capacity: CapacityRange & { sourceLabel?: string };
  sprints: Sprint[];
  commitments: WorkItem[];
}

/** Persistence used by the negotiation flow (Forge SQL in production, in-memory in tests). */
export interface NegotiationStore {
  getRequest(id: string): Promise<DependencyRequest | null>;
  /**
   * Inserts the request unless an open request (`OPEN_REQUEST_STATUSES`) exists for the same source issue and
   * provider, or the provider received `maxPerProviderPerHour` requests in the last hour (checked in one statement).
   * Requests Accord opens itself (`createdBy` = APP_CREATOR) do not count towards that hourly limit.
   */
  insertRequest(request: DependencyRequest, limits: { maxPerProviderPerHour: number }): Promise<InsertRequestResult>;
  /** Conditional transition; returns false when the current status is not in `from`. */
  transition(id: string, from: readonly RequestStatus[], to: RequestStatus): Promise<boolean>;
  getRound(requestId: string, roundNo: 1 | 2, role: RoundRole): Promise<RoundRecord | null>;
  listRounds(requestId: string): Promise<RoundRecord[]>;
  /** Creates or resets the round to `running`; returns its id. */
  startRound(requestId: string, roundNo: 1 | 2, role: RoundRole, input: unknown): Promise<number>;
  finishRound(roundId: number, output: unknown): Promise<void>;
  failRound(roundId: number, error: string): Promise<void>;
  /** Replaces all options of a round (safe on retry). */
  replaceOptions(requestId: string, roundId: number, options: ReadonlyArray<Omit<StoredOption, 'id' | 'requestId' | 'roundId'>>): Promise<StoredOption[]>;
  listOptions(requestId: string): Promise<StoredOption[]>;
  setRecommended(requestId: string, optionId: number): Promise<void>;
  listApprovals(requestId: string): Promise<Approval[]>;
  /**
   * Inserts the decision only while the request still has status `whenStatus`
   * (single conditional INSERT … SELECT); returns false when nothing was inserted.
   */
  addApproval(approval: Omit<Approval, 'id' | 'createdAt'>, whenStatus: RequestStatus): Promise<boolean>;
  getContract(requestId: string): Promise<Contract | null>;
  /** INSERT-if-missing keyed by request id (contracts.request_id is UNIQUE). */
  ensureContract(requestId: string, optionId: number, range: DateRange): Promise<Contract>;
  setContractDeliverable(requestId: string, issueKey: string): Promise<void>;
  setContractStatus(requestId: string, status: ContractStatus): Promise<void>;
  ensureEdge(contractId: number, fromTeamId: string, toTeamId: string): Promise<void>;
  /** Step markers stored in audit_log (entity `request`), used for idempotent side effects. */
  hasStep(requestId: string, step: string): Promise<boolean>;
  /** Same for markers of a contract (entity `contract`), e.g. LINK_CREATED_STEP. */
  hasContractStep(contractId: number, step: string): Promise<boolean>;
  /** Seconds since the latest audit entry of the request (optionally only `step`); null when none. */
  lastStepAgeSeconds(requestId: string, step?: string): Promise<number | null>;
  audit(entityType: string, entityId: string, action: string, actor: string | null, payload: unknown): Promise<void>;
  /**
   * Claims the renegotiation of one contract and at-risk episode (unique key): inserts `claim` unless the pair
   * exists, and returns the request id stored for it (the claimed one, or the one of an earlier attempt).
   */
  claimRenegotiation(claim: Renegotiation): Promise<string>;
  /** Drops the claim of `requestId` unless its request was stored, so the episode is tried again later. */
  releaseRenegotiation(requestId: string): Promise<void>;
  getRenegotiation(requestId: string): Promise<Renegotiation | null>;
  /** Request id of a renegotiation of `contractId` in OPEN_RENEGOTIATION_STATUSES, else null. */
  openRenegotiationFor(contractId: number): Promise<string | null>;
  /**
   * Renegotiations with provider `providerTeamId` that are still negotiating or awaiting approval;
   * with `contractId` only those opened for that contract.
   */
  undecidedRenegotiations(providerTeamId: string, contractId?: number): Promise<string[]>;
}

/** Person a request without agreement is escalated to (FR-15). */
export interface EscalationContact {
  accountId: string;
  /** `charter`: the charter's escalation contact; `project-lead`: fallback to the Jira project lead. */
  source: 'charter' | 'project-lead';
  /** Why the charter contact was not used (for example: cannot browse the source issue's project). */
  note?: string;
}

export interface TeamDirectory {
  getTeam(teamId: string): Promise<Team | null>;
  planningContext(team: Team, neededBy: IsoDate): Promise<PlanningContext>;
  /** Account ids allowed to decide for the team: charter approvers plus the Jira project lead. */
  approvers(team: Team): Promise<string[]>;
  /**
   * Charter escalation contact when they can browse the source issue's project, else the Jira project
   * lead (with a `note`); null when the team has neither.
   */
  escalationContact(team: Team, sourceIssueKey: string): Promise<EscalationContact | null>;
}

/** Jira side effects, all executed as the app from queue jobs. */
export interface JiraPort {
  /** `mentions`: account ids added as ADF mentions (escalations). */
  addComment(issueKey: string, text: string, mentions?: readonly string[]): Promise<void>;
  /** Sets the due date of an existing issue (a renegotiated contract keeps the same deliverable). */
  setDueDate(issueKey: string, dueDate: IsoDate): Promise<void>;
  /** Public display name of an account; null when it cannot be read. */
  displayName(accountId: string): Promise<string | null>;
  findIssueByLabel(projectKey: string, label: string): Promise<string | null>;
  createIssue(projectKey: string, summary: string, dueDate: IsoDate, labels: string[]): Promise<string>;
  /** True only for a Blocks link in this direction: `blocker` blocks `blocked`. */
  hasBlocksLink(blocker: string, blocked: string): Promise<boolean>;
  linkBlocks(blocker: string, blocked: string): Promise<void>;
  moveToSprint(sprintId: string, issueKeys: string[]): Promise<void>;
  moveToBacklog(issueKeys: string[]): Promise<void>;
}

export interface QueuePort {
  push(event: NegotiationEvent): Promise<void>;
}

/** Work ahead of a renegotiated contract as the contract monitor counts it (FR-14, NFR-1). */
export interface RenegotiationWorkAhead extends PlannerWorkAhead {
  pessimistic: number;
  /** Open committed issues of the counted sprints (deliverables excluded). */
  committedIssues: number;
  /** Issues of the provider's other open contracts. */
  contractIssues: number;
  /** Counted commitments that are Highest-priority bugs. */
  criticalBugs: number;
}

export interface NegotiationDeps {
  store: NegotiationStore;
  teams: TeamDirectory;
  jira: JiraPort;
  queue: QueuePort;
  monitor: {
    /** Queues a contract monitor run for one provider team (after a contract is applied). */
    evaluateProvider(providerTeamId: string): Promise<void>;
    /**
     * Work the provider finishes before `contractId` under the monitor rule, with that contract placed after
     * every other open contract; `null` contract id = a new request (after every open contract). Null without
     * capacity data.
     */
    workAhead(providerTeamId: string, contractId: number | null): Promise<RenegotiationWorkAhead | null>;
  };
  today: () => IsoDate;
  /**
   * Jira permissions of the signed-in user (`asUser`), used by `decide`: the app applies the contract,
   * so each approver must hold the Jira permissions for their side of the changes (NFR-3).
   */
  userPermissions(scope: { projectKey: string } | { issueKey: string }, permissions: readonly JiraPermission[]): Promise<Set<JiraPermission>>;
  /**
   * Dual control: one account may not approve for both teams unless demo mode is on (per-installation
   * switch in the Demo tab, admin only, off by default, audited) AND both teams are Accord demo projects.
   * Returns false when the check fails.
   */
  allowSameApprover(teams: { requester: Team; provider: Team }): Promise<boolean>;
}
