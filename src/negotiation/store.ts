import { parseJson, run, select } from '../sql/db';
import { audit } from '../teams/repository';
import type { CostClass, DateRange, OptionKind, ShiftedItem, Size, TraceStep } from '../planner';
import type {
  Approval,
  Contract,
  ContractStatus,
  DependencyRequest,
  NegotiationStore,
  RequestStatus,
  RoundRecord,
  RoundRole,
  StoredOption,
} from './types';
import { OPEN_REQUEST_STATUSES } from './types';

interface RequestRow {
  id: string;
  requester_team_id: string;
  provider_team_id: string;
  source_issue_key: string;
  title: string;
  size: string;
  size_corrected: string | null;
  min_size: number | null;
  needed_by: string;
  cost_class: string;
  status: string;
  created_by: string;
  created_at: string;
}

const date = (value: unknown): string => (value ? String(value).slice(0, 10) : '');

export const toRequest = (row: RequestRow): DependencyRequest => ({
  id: row.id,
  requesterTeamId: row.requester_team_id,
  providerTeamId: row.provider_team_id,
  sourceIssueKey: row.source_issue_key,
  title: row.title,
  size: (row.size_corrected ?? row.size) as Size,
  minSize: row.min_size === null ? null : Number(row.min_size),
  neededBy: date(row.needed_by),
  costClass: row.cost_class as CostClass,
  status: row.status as RequestStatus,
  createdBy: row.created_by,
  createdAt: String(row.created_at),
});

interface RoundRow {
  id: number;
  request_id: string;
  round_no: number;
  role: string;
  input: unknown;
  output: unknown;
  status: string;
  error: string | null;
  created_at: string;
}

const toRound = (row: RoundRow): RoundRecord => ({
  id: Number(row.id),
  requestId: row.request_id,
  roundNo: Number(row.round_no) as 1 | 2,
  role: row.role as RoundRole,
  input: parseJson<unknown>(row.input, null),
  output: parseJson<unknown>(row.output, null),
  status: row.status as RoundRecord['status'],
  error: row.error,
  createdAt: String(row.created_at),
});

interface OptionRow {
  id: number;
  request_id: string;
  round_id: number | null;
  kind: string;
  date_min: string | null;
  date_max: string | null;
  shifted_issues: unknown;
  rules_used: unknown;
  trace: unknown;
  meets_need: number | boolean;
  shift_cost: number;
  recommended: number | boolean;
}

const toOption = (row: OptionRow): StoredOption => ({
  id: Number(row.id),
  requestId: row.request_id,
  roundId: row.round_id === null ? null : Number(row.round_id),
  kind: row.kind as OptionKind,
  dateRange: { min: date(row.date_min), max: date(row.date_max) },
  shifted: parseJson<ShiftedItem[]>(row.shifted_issues, []),
  rulesUsed: parseJson<string[]>(row.rules_used, []),
  trace: parseJson<TraceStep[]>(row.trace, []),
  meetsNeed: Boolean(Number(row.meets_need)),
  shiftCost: Number(row.shift_cost),
  recommended: Boolean(Number(row.recommended)),
});

interface ApprovalRow {
  id: number;
  request_id: string;
  option_id: number;
  team_id: string;
  actor_account_id: string;
  decision: string;
  reason: string | null;
  created_at: string;
}

const toApproval = (row: ApprovalRow): Approval => ({
  id: Number(row.id),
  requestId: row.request_id,
  optionId: Number(row.option_id),
  teamId: row.team_id,
  actorAccountId: row.actor_account_id,
  decision: row.decision as Approval['decision'],
  reason: row.reason,
  createdAt: String(row.created_at),
});

interface ContractRow {
  id: number;
  request_id: string;
  option_id: number;
  deliverable_issue_key: string | null;
  agreed_date_min: string;
  agreed_date_max: string;
  status: string;
  projected_date: string | null;
}

export const toContract = (row: ContractRow): Contract => ({
  id: Number(row.id),
  requestId: row.request_id,
  optionId: Number(row.option_id),
  deliverableIssueKey: row.deliverable_issue_key,
  agreedDateMin: date(row.agreed_date_min),
  agreedDateMax: date(row.agreed_date_max),
  status: row.status as ContractStatus,
  projectedDate: row.projected_date ? date(row.projected_date) : null,
});

const nullableDate = (value: string) => (value ? value : null);

export const sqlStore: NegotiationStore = {
  async getRequest(id) {
    const rows = await select<RequestRow>('SELECT * FROM requests WHERE id = ?', [id]);
    return rows[0] ? toRequest(rows[0]) : null;
  },
  async insertRequest(request, limits) {
    // One statement: the duplicate and provider-rate checks hold at insert time (no read-then-write gap).
    const active = OPEN_REQUEST_STATUSES;
    const result = await run(
      `INSERT INTO requests (id, requester_team_id, provider_team_id, source_issue_key, title, size, min_size, needed_by,
         cost_class, status, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM requests WHERE source_issue_key = ? AND provider_team_id = ? AND status IN (${marks(active)}))
         AND (SELECT COUNT(*) FROM requests WHERE provider_team_id = ? AND created_at > CURRENT_TIMESTAMP - INTERVAL 1 HOUR) < ?`,
      [
        request.id,
        request.requesterTeamId,
        request.providerTeamId,
        request.sourceIssueKey,
        request.title,
        request.size,
        request.minSize,
        request.neededBy,
        request.costClass,
        request.status,
        request.createdBy,
        request.sourceIssueKey,
        request.providerTeamId,
        ...active,
        request.providerTeamId,
        limits.maxPerProviderPerHour,
      ],
    );
    if (result.affectedRows > 0) return 'inserted';
    const duplicate = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM requests WHERE source_issue_key = ? AND provider_team_id = ? AND status IN (${marks(active)})`,
      [request.sourceIssueKey, request.providerTeamId, ...active],
    );
    return Number(duplicate[0]?.n ?? 0) > 0 ? 'duplicate' : 'provider-limit';
  },
  async transition(id, from, to) {
    const placeholders = from.map(() => '?').join(', ');
    const result = await run(`UPDATE requests SET status = ? WHERE id = ? AND status IN (${placeholders})`, [to, id, ...from]);
    return result.affectedRows > 0;
  },
  async getRound(requestId, roundNo, role) {
    const rows = await select<RoundRow>(
      'SELECT * FROM negotiation_rounds WHERE request_id = ? AND round_no = ? AND role = ?',
      [requestId, roundNo, role],
    );
    return rows[0] ? toRound(rows[0]) : null;
  },
  async listRounds(requestId) {
    const rows = await select<RoundRow>('SELECT * FROM negotiation_rounds WHERE request_id = ? ORDER BY id', [requestId]);
    return rows.map(toRound);
  },
  async startRound(requestId, roundNo, role, input) {
    await run(
      `INSERT INTO negotiation_rounds (request_id, round_no, role, input, status) VALUES (?, ?, ?, ?, 'running')
       ON DUPLICATE KEY UPDATE input = VALUES(input), status = 'running', error = NULL`,
      [requestId, roundNo, role, JSON.stringify(input ?? null)],
    );
    const round = await this.getRound(requestId, roundNo, role);
    if (!round) throw new Error(`Round ${roundNo}/${role} of ${requestId} was not stored`);
    return round.id;
  },
  async finishRound(roundId, output) {
    await run("UPDATE negotiation_rounds SET output = ?, status = 'done', error = NULL WHERE id = ?", [
      JSON.stringify(output ?? null),
      roundId,
    ]);
  },
  async failRound(roundId, error) {
    await run("UPDATE negotiation_rounds SET status = 'failed', error = ? WHERE id = ?", [error.slice(0, 2000), roundId]);
  },
  async replaceOptions(requestId, roundId, options) {
    await run('DELETE FROM options WHERE request_id = ? AND round_id = ?', [requestId, roundId]);
    for (const option of options) {
      await run(
        `INSERT INTO options (request_id, round_id, kind, date_min, date_max, shifted_issues, rules_used, trace,
           meets_need, shift_cost, recommended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
        [
          requestId,
          roundId,
          option.kind,
          nullableDate(option.dateRange.min),
          nullableDate(option.dateRange.max),
          JSON.stringify(option.shifted),
          JSON.stringify(option.rulesUsed),
          JSON.stringify(option.trace),
          option.meetsNeed,
          option.shiftCost,
        ],
      );
    }
    return (await this.listOptions(requestId)).filter((option) => option.roundId === roundId);
  },
  async listOptions(requestId) {
    const rows = await select<OptionRow>('SELECT * FROM options WHERE request_id = ? ORDER BY id', [requestId]);
    return rows.map(toOption);
  },
  async setRecommended(requestId, optionId) {
    await run('UPDATE options SET recommended = (id = ?) WHERE request_id = ?', [optionId, requestId]);
  },
  async listApprovals(requestId) {
    const rows = await select<ApprovalRow>('SELECT * FROM approvals WHERE request_id = ? ORDER BY id', [requestId]);
    return rows.map(toApproval);
  },
  async addApproval(approval, whenStatus) {
    // Guarded by the request status in the same statement, so a decision never lands after the request moved on.
    const result = await run(
      `INSERT INTO approvals (request_id, option_id, team_id, actor_account_id, decision, reason)
       SELECT ?, ?, ?, ?, ?, ? FROM requests WHERE id = ? AND status = ?`,
      [
        approval.requestId,
        approval.optionId,
        approval.teamId,
        approval.actorAccountId,
        approval.decision,
        approval.reason,
        approval.requestId,
        whenStatus,
      ],
    );
    return result.affectedRows > 0;
  },
  async getContract(requestId) {
    const rows = await select<ContractRow>('SELECT * FROM contracts WHERE request_id = ?', [requestId]);
    return rows[0] ? toContract(rows[0]) : null;
  },
  async ensureContract(requestId, optionId, range: DateRange) {
    await run(
      `INSERT IGNORE INTO contracts (request_id, option_id, agreed_date_min, agreed_date_max, status)
       VALUES (?, ?, ?, ?, 'applying')`,
      [requestId, optionId, range.min, range.max],
    );
    const contract = await this.getContract(requestId);
    if (!contract) throw new Error(`Contract for ${requestId} was not stored`);
    return contract;
  },
  async setContractDeliverable(requestId, issueKey) {
    await run('UPDATE contracts SET deliverable_issue_key = ? WHERE request_id = ?', [issueKey, requestId]);
  },
  async setContractStatus(requestId, status) {
    await run('UPDATE contracts SET status = ? WHERE request_id = ?', [status, requestId]);
  },
  async ensureEdge(contractId, fromTeamId, toTeamId) {
    // dependency_edges.contract_id is UNIQUE (v012), so a concurrent retry cannot add a second edge.
    await run('INSERT IGNORE INTO dependency_edges (contract_id, from_team_id, to_team_id) VALUES (?, ?, ?)', [
      contractId,
      fromTeamId,
      toTeamId,
    ]);
  },
  async hasStep(requestId, step) {
    const rows = await select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'request' AND entity_id = ? AND action = ?",
      [requestId, step],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  },
  async lastStepAgeSeconds(requestId, step) {
    const rows = await select<{ age: number | null }>(
      `SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), CURRENT_TIMESTAMP) AS age FROM audit_log
       WHERE entity_type = 'request' AND entity_id = ?${step ? ' AND action = ?' : ''}`,
      step ? [requestId, step] : [requestId],
    );
    const age = rows[0]?.age;
    return age === null || age === undefined ? null : Number(age);
  },
  audit,
};

/** Requests whose source issue or provider deliverable is `issueKey`, newest first. */
export async function requestsForIssue(issueKey: string): Promise<DependencyRequest[]> {
  const rows = await select<RequestRow>(
    `SELECT r.* FROM requests r LEFT JOIN contracts c ON c.request_id = r.id
     WHERE r.source_issue_key = ? OR c.deliverable_issue_key = ? ORDER BY r.created_at DESC LIMIT 10`,
    [issueKey, issueKey],
  );
  return rows.map(toRequest);
}

export async function requestsByStatus(statuses: readonly RequestStatus[], limit = 50): Promise<DependencyRequest[]> {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await select<RequestRow>(
    `SELECT * FROM requests WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
    [...statuses],
  );
  return rows.map(toRequest);
}

const marks = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/** Requests where one of `teamIds` is requester or provider; the team filter runs before the limit. */
export async function requestsForTeams(
  teamIds: readonly string[],
  statuses: readonly RequestStatus[],
  limit = 50,
): Promise<DependencyRequest[]> {
  if (teamIds.length === 0 || statuses.length === 0) return [];
  const rows = await select<RequestRow>(
    `SELECT * FROM requests WHERE status IN (${marks(statuses)})
       AND (requester_team_id IN (${marks(teamIds)}) OR provider_team_id IN (${marks(teamIds)}))
     ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
    [...statuses, ...teamIds, ...teamIds],
  );
  return rows.map(toRequest);
}

/** Approvals of several requests in one query, grouped by request id. */
export async function approvalsByRequest(requestIds: readonly string[]): Promise<Map<string, Approval[]>> {
  const grouped = new Map<string, Approval[]>(requestIds.map((id) => [id, []]));
  if (requestIds.length === 0) return grouped;
  const rows = await select<ApprovalRow>(`SELECT * FROM approvals WHERE request_id IN (${marks(requestIds)}) ORDER BY id`, [
    ...requestIds,
  ]);
  for (const row of rows) grouped.get(row.request_id)?.push(toApproval(row));
  return grouped;
}

/** Requests created by `accountId` within the last hour (rate limit). */
export async function recentRequestCount(accountId: string): Promise<number> {
  const rows = await select<{ n: number }>(
    'SELECT COUNT(*) AS n FROM requests WHERE created_by = ? AND created_at > CURRENT_TIMESTAMP - INTERVAL 1 HOUR',
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface DependencyEdge {
  contractId: number;
  fromTeamId: string;
  toTeamId: string;
}

/** Agreed dependency edges (requester → provider), newest first (FR-13). */
export async function listEdges(limit = 200): Promise<DependencyEdge[]> {
  const rows = await select<{ contract_id: number; from_team_id: string; to_team_id: string }>(
    `SELECT contract_id, from_team_id, to_team_id FROM dependency_edges ORDER BY id DESC LIMIT ${Math.floor(limit)}`,
  );
  return rows.map((row) => ({ contractId: Number(row.contract_id), fromTeamId: row.from_team_id, toTeamId: row.to_team_id }));
}

export interface AuditEntry {
  id: number;
  entityType: string;
  entityId: string;
  action: string;
  actorAccountId: string | null;
  payload: unknown;
  createdAt: string;
}

/** Latest audit entries of the given requests and contracts (viewer filter in SQL, before the limit). */
export async function auditFor(requestIds: readonly string[], contractIds: readonly number[], limit = 50): Promise<AuditEntry[]> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (requestIds.length) {
    clauses.push(`(entity_type = 'request' AND entity_id IN (${marks(requestIds)}))`);
    params.push(...requestIds);
  }
  if (contractIds.length) {
    clauses.push(`(entity_type = 'contract' AND entity_id IN (${marks(contractIds)}))`);
    params.push(...contractIds.map(String));
  }
  if (clauses.length === 0) return [];
  const rows = await select<{
    id: number;
    entity_type: string;
    entity_id: string;
    action: string;
    actor_account_id: string | null;
    payload: unknown;
    created_at: string;
  }>(`SELECT * FROM audit_log WHERE ${clauses.join(' OR ')} ORDER BY created_at DESC, id DESC LIMIT ${Math.floor(limit)}`, params);
  return rows.map((row) => ({
    id: Number(row.id),
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorAccountId: row.actor_account_id,
    payload: parseJson<unknown>(row.payload, null),
    createdAt: String(row.created_at),
  }));
}

export interface ContractListRow {
  contract: Contract;
  request: DependencyRequest;
}

const CONTRACT_JOIN = `SELECT c.*, r.id AS r_id, r.requester_team_id, r.provider_team_id, r.source_issue_key, r.title, r.size,
       r.size_corrected, r.min_size, r.needed_by, r.cost_class, r.status AS r_status, r.created_by, r.created_at
     FROM contracts c JOIN requests r ON r.id = c.request_id`;

type ContractJoinRow = ContractRow & { r_id: string } & Record<string, unknown>;

const toContractListRow = (row: ContractJoinRow): ContractListRow => ({
  contract: toContract(row),
  request: toRequest({ ...(row as unknown as RequestRow), id: row.r_id, status: String(row.r_status) }),
});

/** Newest contracts for the Contracts tab / list-contracts action (display list, capped). */
export async function listContracts(teamId?: string): Promise<ContractListRow[]> {
  const rows = await select<ContractJoinRow>(
    `${CONTRACT_JOIN}
     ${teamId ? 'WHERE r.requester_team_id = ? OR r.provider_team_id = ?' : ''}
     ORDER BY c.id DESC LIMIT 100`,
    teamId ? [teamId, teamId] : [],
  );
  return rows.map(toContractListRow);
}

/** Every contract of `providerTeamId` in one of `statuses` (no limit: the monitor must see all work ahead). */
export async function contractsForProvider(providerTeamId: string, statuses: readonly string[]): Promise<ContractListRow[]> {
  if (statuses.length === 0) return [];
  const rows = await select<ContractJoinRow>(
    `${CONTRACT_JOIN} WHERE r.provider_team_id = ? AND c.status IN (${marks(statuses)}) ORDER BY c.agreed_date_max, c.id`,
    [providerTeamId, ...statuses],
  );
  return rows.map(toContractListRow);
}

/** Contracts of the given requests (no limit; the caller bounds the request list). */
export async function contractsForRequests(requestIds: readonly string[]): Promise<ContractListRow[]> {
  if (requestIds.length === 0) return [];
  const rows = await select<ContractJoinRow>(`${CONTRACT_JOIN} WHERE c.request_id IN (${marks(requestIds)})`, [...requestIds]);
  return rows.map(toContractListRow);
}

/** Stored options by id (audit summaries). */
export async function optionsByIds(ids: readonly number[]): Promise<Map<number, StoredOption>> {
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return new Map();
  const rows = await select<OptionRow>(`SELECT * FROM options WHERE id IN (${marks(unique)})`, unique);
  return new Map(rows.map((row) => [Number(row.id), toOption(row)]));
}
