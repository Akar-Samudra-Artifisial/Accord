import { CHARTER, SPRINTS, baseInput } from '../planner/fixtures';
import type { Team } from '../../src/teams/repository';
import type {
  Approval,
  Contract,
  DependencyRequest,
  InsertRequestResult,
  JiraPort,
  NegotiationDeps,
  NegotiationEvent,
  NegotiationStore,
  PlanningContext,
  RequestStatus,
  RoundRecord,
  StoredOption,
} from '../../src/negotiation/types';
import { OPEN_REQUEST_STATUSES } from '../../src/negotiation/types';

export const MOB: Team = {
  id: 'team-MOB',
  teamKey: 'MOB',
  name: 'Mobile',
  jiraProjectKey: 'MOB',
  boardId: 4,
  leadAccountId: 'lead-mobile',
  charterPageId: '1',
};

export const PAY: Team = {
  id: 'team-PAY',
  teamKey: 'PAY',
  name: 'Payments',
  jiraProjectKey: 'PAY',
  boardId: 5,
  leadAccountId: 'lead-payments-project',
  charterPageId: '2',
};

export const REQUEST_ID = 'req-00000000-0000-4000-8000-000000000001';

export function request(overrides: Partial<DependencyRequest> = {}): DependencyRequest {
  return {
    id: REQUEST_ID,
    requesterTeamId: MOB.id,
    providerTeamId: PAY.id,
    sourceIssueKey: 'MOB-7',
    title: 'Refund API',
    size: 'M',
    minSize: null,
    neededBy: '2026-11-29',
    costClass: 'fixed-date',
    status: 'negotiating',
    createdBy: 'lead-mobile',
    createdAt: '2026-11-05T10:00:00Z',
    ...overrides,
  };
}

/** In-memory NegotiationStore with the same semantics as the SQL store. */
export class MemoryStore implements NegotiationStore {
  requests = new Map<string, DependencyRequest>();
  rounds: RoundRecord[] = [];
  options: StoredOption[] = [];
  approvals: Approval[] = [];
  contracts: Contract[] = [];
  edges: Array<{ contractId: number; from: string; to: string }> = [];
  auditLog: Array<{ entityType: string; entityId: string; action: string; actor: string | null; payload: unknown; at: number }> = [];
  /** Fake clock in seconds, used by lastStepAgeSeconds. */
  now = 0;
  private nextId = 1;

  async getRequest(id: string) {
    const found = this.requests.get(id);
    return found ? { ...found } : null;
  }
  /** Insert times (fake clock) used for the per-provider hourly limit. */
  insertedAt = new Map<string, number>();

  async insertRequest(value: DependencyRequest, limits = { maxPerProviderPerHour: Infinity }): Promise<InsertRequestResult> {
    const all = [...this.requests.values()];
    const duplicate = all.some(
      (r) => r.sourceIssueKey === value.sourceIssueKey && r.providerTeamId === value.providerTeamId && OPEN_REQUEST_STATUSES.includes(r.status),
    );
    if (duplicate) return 'duplicate';
    const lastHour = all.filter((r) => r.providerTeamId === value.providerTeamId && this.now - (this.insertedAt.get(r.id) ?? -Infinity) < 3600);
    if (lastHour.length >= limits.maxPerProviderPerHour) return 'provider-limit';
    this.requests.set(value.id, { ...value });
    this.insertedAt.set(value.id, this.now);
    return 'inserted';
  }
  async transition(id: string, from: readonly DependencyRequest['status'][], to: DependencyRequest['status']) {
    const current = this.requests.get(id);
    if (!current || !from.includes(current.status)) return false;
    this.requests.set(id, { ...current, status: to });
    return true;
  }
  async getRound(requestId: string, roundNo: 1 | 2, role: RoundRecord['role']) {
    return this.rounds.find((r) => r.requestId === requestId && r.roundNo === roundNo && r.role === role) ?? null;
  }
  async listRounds(requestId: string) {
    return this.rounds.filter((r) => r.requestId === requestId);
  }
  async startRound(requestId: string, roundNo: 1 | 2, role: RoundRecord['role'], input: unknown) {
    const existing = await this.getRound(requestId, roundNo, role);
    if (existing) {
      Object.assign(existing, { input, status: 'running', error: null });
      return existing.id;
    }
    const id = this.nextId++;
    this.rounds.push({ id, requestId, roundNo, role, input, output: null, status: 'running', error: null, createdAt: '' });
    return id;
  }
  async finishRound(roundId: number, output: unknown) {
    Object.assign(this.rounds.find((r) => r.id === roundId) ?? {}, { output, status: 'done', error: null });
  }
  async failRound(roundId: number, error: string) {
    Object.assign(this.rounds.find((r) => r.id === roundId) ?? {}, { status: 'failed', error });
  }
  async replaceOptions(requestId: string, roundId: number, drafts: ReadonlyArray<Omit<StoredOption, 'id' | 'requestId' | 'roundId'>>) {
    this.options = this.options.filter((o) => !(o.requestId === requestId && o.roundId === roundId));
    const stored = drafts.map((draft) => ({ ...draft, id: this.nextId++, requestId, roundId }));
    this.options.push(...stored);
    return stored;
  }
  async listOptions(requestId: string) {
    return this.options.filter((o) => o.requestId === requestId);
  }
  async setRecommended(requestId: string, optionId: number) {
    for (const option of this.options) if (option.requestId === requestId) option.recommended = option.id === optionId;
  }
  async listApprovals(requestId: string) {
    return this.approvals.filter((a) => a.requestId === requestId);
  }
  async addApproval(approval: Omit<Approval, 'id' | 'createdAt'>, whenStatus: RequestStatus) {
    if ((await this.getRequest(approval.requestId))?.status !== whenStatus) return false;
    this.approvals.push({ ...approval, id: this.nextId++, createdAt: '' });
    return true;
  }
  async getContract(requestId: string) {
    return this.contracts.find((c) => c.requestId === requestId) ?? null;
  }
  async ensureContract(requestId: string, optionId: number, range: { min: string; max: string }) {
    const existing = await this.getContract(requestId);
    if (existing) return { ...existing };
    const contract: Contract = {
      id: this.nextId++,
      requestId,
      optionId,
      deliverableIssueKey: null,
      agreedDateMin: range.min,
      agreedDateMax: range.max,
      status: 'applying',
      projectedDate: null,
    };
    this.contracts.push(contract);
    return { ...contract };
  }
  async setContractDeliverable(requestId: string, issueKey: string) {
    Object.assign(this.contracts.find((c) => c.requestId === requestId) ?? {}, { deliverableIssueKey: issueKey });
  }
  async setContractStatus(requestId: string, status: Contract['status']) {
    Object.assign(this.contracts.find((c) => c.requestId === requestId) ?? {}, { status });
  }
  async ensureEdge(contractId: number, from: string, to: string) {
    if (!this.edges.some((e) => e.contractId === contractId)) this.edges.push({ contractId, from, to });
  }
  async hasStep(requestId: string, step: string) {
    return this.auditLog.some((e) => e.entityType === 'request' && e.entityId === requestId && e.action === step);
  }
  async lastStepAgeSeconds(requestId: string, step?: string) {
    const times = this.auditLog
      .filter((e) => e.entityType === 'request' && e.entityId === requestId && (!step || e.action === step))
      .map((e) => e.at);
    return times.length ? this.now - Math.max(...times) : null;
  }
  async audit(entityType: string, entityId: string, action: string, actor: string | null, payload: unknown) {
    this.auditLog.push({ entityType, entityId, action, actor, payload, at: this.now });
  }
}

export class FakeJira implements JiraPort {
  comments: Array<{ issueKey: string; text: string }> = [];
  created: Array<{ projectKey: string; key: string; labels: string[]; dueDate: string }> = [];
  links: Array<{ blocker: string; blocked: string }> = [];
  sprintMoves: Array<{ sprintId: string; keys: string[] }> = [];
  backlogMoves: string[][] = [];
  /** When set, createIssue succeeds in Jira but then throws (simulates a crash before SQL is updated). */
  failAfterCreate = false;
  /** When set, findIssueByLabel does not see created issues yet (Jira search index lag). */
  searchLag = false;
  failComment = false;

  async addComment(issueKey: string, text: string) {
    if (this.failComment) throw new Error('comment failed');
    this.comments.push({ issueKey, text });
  }
  async findIssueByLabel(projectKey: string, label: string) {
    if (this.searchLag) return null;
    return this.created.find((issue) => issue.projectKey === projectKey && issue.labels.includes(label))?.key ?? null;
  }
  async createIssue(projectKey: string, _summary: string, dueDate: string, labels: string[]) {
    const key = `${projectKey}-${100 + this.created.length}`;
    this.created.push({ projectKey, key, labels, dueDate });
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error('network error after create');
    }
    return key;
  }
  async hasBlocksLink(blocker: string, blocked: string) {
    return this.links.some((link) => link.blocker === blocker && link.blocked === blocked);
  }
  async linkBlocks(blocker: string, blocked: string) {
    this.links.push({ blocker, blocked });
  }
  async moveToSprint(sprintId: string, keys: string[]) {
    this.sprintMoves.push({ sprintId, keys });
  }
  async moveToBacklog(keys: string[]) {
    this.backlogMoves.push(keys);
  }
}

export interface Harness {
  deps: NegotiationDeps;
  store: MemoryStore;
  jira: FakeJira;
  pushed: NegotiationEvent[];
  planningCalls: { count: number };
  /** Provider team ids passed to `monitor.evaluateProvider`. */
  monitorRuns: string[];
}

/** Payments planning context from the planner fixtures (capacity 9–10, share 50%). */
export function harness(context: Partial<PlanningContext> = {}): Harness {
  const store = new MemoryStore();
  const jira = new FakeJira();
  const pushed: NegotiationEvent[] = [];
  const planningCalls = { count: 0 };
  const monitorRuns: string[] = [];
  const base = baseInput();
  const planning: PlanningContext = {
    charter: { ...CHARTER, approvers: ['lead-payments'] },
    capacity: base.capacity,
    sprints: SPRINTS,
    commitments: [],
    ...context,
  };
  const teams = new Map([MOB, PAY].map((team) => [team.id, team]));
  const deps: NegotiationDeps = {
    store,
    jira,
    queue: { push: async (event) => void pushed.push(event) },
    monitor: { evaluateProvider: async (teamId) => void monitorRuns.push(teamId) },
    today: () => '2026-11-05',
    allowSameApprover: false,
    teams: {
      getTeam: async (id) => teams.get(id) ?? null,
      planningContext: async () => {
        planningCalls.count += 1;
        return planning;
      },
      approvers: async (team) => (team.id === PAY.id ? ['lead-payments', 'lead-payments-project'] : ['lead-mobile']),
    },
  };
  return { deps, store, jira, pushed, planningCalls, monitorRuns };
}
