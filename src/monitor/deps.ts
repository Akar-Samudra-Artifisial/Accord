import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import type { ContractStatus } from '../negotiation/types';
import { cancelRenegotiationsBackOnTrack, openRenegotiation } from '../negotiation/orchestrator';
import { run, select } from '../sql/db';
import { addComment, ISSUE_KEY, searchIssues } from '../jira/issues';
import { audit } from '../teams/repository';
import { loadCommitments, teamCapacity } from '../teams/service';
import { contractsForProvider } from '../negotiation/store';
import { productionDeps, teamDirectory } from '../negotiation/deps';
import { MONITOR_QUEUE_KEY, MONITORED_STATUSES, type MonitorDeps, type MonitorEvent, type MonitorStore } from './monitor';

export { MONITOR_QUEUE_KEY, type MonitorEvent };

const TEAM_ID = /^team-[A-Z][A-Z0-9_]{1,9}$/;

export function parseMonitorEvent(body: unknown): MonitorEvent | null {
  if (!body || typeof body !== 'object') return null;
  const { type, teamId } = body as Record<string, unknown>;
  return type === 'monitor-team' && typeof teamId === 'string' && TEAM_ID.test(teamId) ? { type, teamId } : null;
}

const marks = (values: readonly unknown[]) => values.map(() => '?').join(', ');

export const sqlMonitorStore: MonitorStore = {
  async providersWithContracts() {
    const rows = await select<{ provider_team_id: string }>(
      `SELECT DISTINCT r.provider_team_id FROM contracts c JOIN requests r ON r.id = c.request_id
       WHERE c.status IN (${marks(MONITORED_STATUSES)}) ORDER BY r.provider_team_id`,
      [...MONITORED_STATUSES],
    );
    return rows.map((row) => row.provider_team_id);
  },
  contractsForProvider: (providerTeamId) => contractsForProvider(providerTeamId, MONITORED_STATUSES),
  async saveEvaluation(contractId, from, to, projectedDate) {
    const result = await run(
      'UPDATE contracts SET status = ?, projected_date = ?, last_evaluated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
      [to, projectedDate, contractId, from],
    );
    return result.affectedRows > 0;
  },
  async lastNotification(contractId) {
    const rows = await select<{ seq: number; status: string; issue_key: string }>(
      `SELECT seq, status, issue_key FROM contract_notifications
       WHERE contract_id = ? AND seq = (SELECT MAX(seq) FROM contract_notifications WHERE contract_id = ?)`,
      [contractId, contractId],
    );
    if (rows.length === 0) return null;
    return { seq: Number(rows[0].seq), status: rows[0].status as ContractStatus, issueKeys: rows.map((row) => row.issue_key) };
  },
  async claimNotification(contractId, seq, status, projectedDate, issueKey) {
    const result = await run(
      `INSERT IGNORE INTO contract_notifications (contract_id, seq, status, projected_date, issue_key) VALUES (?, ?, ?, ?, ?)`,
      [contractId, seq, status, projectedDate, issueKey],
    );
    return result.affectedRows > 0;
  },
  async renegotiationBaseline(requestId) {
    const rows = await select<{ projected_date: string | null }>(
      `SELECT c.projected_date FROM renegotiations n JOIN contracts c ON c.id = n.contract_id WHERE n.request_id = ?`,
      [requestId],
    );
    if (rows.length === 0) return null;
    const projected = rows[0].projected_date;
    return { projectedDate: projected ? String(projected).slice(0, 10) : null };
  },
  audit,
};

/** ADF mentions only accept Atlassian account ids. */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export const monitorDeps: MonitorDeps = {
  store: sqlMonitorStore,
  teams: {
    // Wrapped: negotiation/deps imports this module back, so teamDirectory is only read at call time.
    getTeam: (teamId) => teamDirectory.getTeam(teamId),
    capacity: teamCapacity,
    approvers: (team) => teamDirectory.approvers(team),
  },
  jira: {
    commitments: (team) => loadCommitments(team),
    async doneIssueKeys(issueKeys) {
      const valid = [...new Set(issueKeys)].filter((key) => ISSUE_KEY.test(key));
      if (valid.length === 0) return new Set();
      const issues = await searchIssues(`key in (${valid.join(',')}) AND statusCategory = Done`, valid.length);
      return new Set(issues.map((issue) => issue.key));
    },
    async addComment(issueKey, text, mentions) {
      await addComment(issueKey, text, mentions.filter((id) => ACCOUNT_ID.test(id)));
    },
  },
  today: () => new Date().toISOString().slice(0, 10),
  renegotiate: (trigger) => openRenegotiation(productionDeps, trigger, `req-${randomUUID()}`),
  cancelRenegotiations: (contract, request) => cancelRenegotiationsBackOnTrack(productionDeps, request, contract.id),
};

/** Queues one `monitor-team` job per provider team with monitored contracts. */
export async function scheduleMonitor(trigger: 'schedule' | 'manual' | 'diag', actor: string | null): Promise<string[]> {
  const teamIds = await sqlMonitorStore.providersWithContracts();
  await audit('monitor', 'daily', 'monitor-started', actor, { trigger, teams: teamIds });
  if (teamIds.length > 0) {
    await new Queue({ key: MONITOR_QUEUE_KEY }).push(teamIds.map((teamId) => ({ body: { type: 'monitor-team', teamId } })));
  }
  return teamIds;
}
