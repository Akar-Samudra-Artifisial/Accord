import type {
  CapacityRange,
  Charter,
  CostClass,
  DateRange,
  IsoDate,
  OptionKind,
  ShiftedItem,
  Size,
  Sprint,
  TraceStep,
  WorkItem,
} from '../planner';
import type { Team } from '../teams/repository';

/** Lifecycle of a dependency request (PRD: Negotiating → Awaiting approval → Contracted). */
export type RequestStatus = 'negotiating' | 'awaiting-approval' | 'approved' | 'contracted' | 'rejected' | 'failed';

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

export type ContractStatus = 'applying' | 'on-track' | 'at-risk';

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
  insertRequest(request: DependencyRequest): Promise<void>;
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
  /** Seconds since the latest audit entry of the request (optionally only `step`); null when none. */
  lastStepAgeSeconds(requestId: string, step?: string): Promise<number | null>;
  audit(entityType: string, entityId: string, action: string, actor: string | null, payload: unknown): Promise<void>;
}

export interface TeamDirectory {
  getTeam(teamId: string): Promise<Team | null>;
  planningContext(team: Team, neededBy: IsoDate): Promise<PlanningContext>;
  /** Account ids allowed to decide for the team: charter approvers plus the Jira project lead. */
  approvers(team: Team): Promise<string[]>;
}

/** Jira side effects, all executed as the app from queue jobs. */
export interface JiraPort {
  addComment(issueKey: string, text: string): Promise<void>;
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

export interface NegotiationDeps {
  store: NegotiationStore;
  teams: TeamDirectory;
  jira: JiraPort;
  queue: QueuePort;
  today: () => IsoDate;
  /**
   * Dual control: one account may not approve for both teams unless this demo
   * switch is on (env `ACCORD_DEMO_ALLOW_SAME_APPROVER=true`, development only).
   */
  allowSameApprover: boolean;
}
