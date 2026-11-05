import { AtlassianApiError, isNotFound } from '../atlassian/http';
import {
  addIssueLabel,
  appAccountId,
  deleteIssueComment,
  deleteIssueLink,
  listIssueComments,
  getIssue,
  isBlocksFrom,
  ISSUE_KEY,
  listIssueLinks,
  listSprintIssues,
  searchIssues,
  transitionToDone,
} from '../jira/issues';
import { getSprint, moveIssuesToBacklog, moveIssuesToSprint } from '../jira/sprints';
import { parseJson, run, select } from '../sql/db';
import { audit, getTeamByProjectKey } from '../teams/repository';
import { ARCHIVED_LABEL, type DemoCleanPort } from './clean';
import { DEMO_BUG_LABEL, LEGACY_DEMO_BUG_LABEL } from './critical-bugs';
import { demoLeadPort } from './demo-lead';

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const SPRINT_ID = /^[0-9]{1,18}$/;
const marks = (values: readonly unknown[]) => values.map(() => '?').join(', ');
/** IN lists stay short; the demo has a few dozen rows at most. */
const CHUNK = 100;

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) result.push(values.slice(i, i + CHUNK));
  return result;
}

async function auditPayloads(contractIds: readonly number[], action: string): Promise<Record<string, unknown>[]> {
  const payloads: Record<string, unknown>[] = [];
  for (const ids of chunks(contractIds.map(String))) {
    const rows = await select<{ payload: unknown }>(
      `SELECT payload FROM audit_log WHERE entity_type = 'contract' AND action = ? AND entity_id IN (${marks(ids)})`,
      [action, ...ids],
    );
    for (const row of rows) payloads.push(parseJson<Record<string, unknown>>(row.payload, {}));
  }
  return payloads;
}

const issueKey = (value: unknown): string | null => (typeof value === 'string' && ISSUE_KEY.test(value) ? value : null);

export const demoCleanPort: DemoCleanPort = {
  accordProjects: () => demoLeadPort.accordProjects(),
  async teamIdOf(projectKey) {
    return (await getTeamByProjectKey(projectKey))?.id ?? null;
  },
  async requestsBetween(teamIds) {
    const rows = await select<{ id: string; requester_team_id: string; provider_team_id: string }>(
      `SELECT id, requester_team_id, provider_team_id FROM requests
       WHERE requester_team_id IN (${marks(teamIds)}) AND provider_team_id IN (${marks(teamIds)})`,
      [...teamIds, ...teamIds],
    );
    return rows.map((row) => ({ id: row.id, requesterTeamId: row.requester_team_id, providerTeamId: row.provider_team_id }));
  },
  async contractsOf(requestIds) {
    const result = [];
    for (const ids of chunks(requestIds)) {
      const rows = await select<{ id: number; request_id: string; deliverable_issue_key: string | null }>(
        `SELECT id, request_id, deliverable_issue_key FROM contracts WHERE request_id IN (${marks(ids)})`,
        [...ids],
      );
      result.push(...rows.map((row) => ({ id: Number(row.id), requestId: row.request_id, deliverableIssueKey: row.deliverable_issue_key })));
    }
    return result;
  },
  async recordedDeliverables(contractIds) {
    const payloads = await auditPayloads(contractIds, 'deliverable-created');
    return new Set(payloads.map((payload) => issueKey(payload.issueKey)).filter((key): key is string => key !== null));
  },
  async recordedLinks(contractIds) {
    const payloads = await auditPayloads(contractIds, 'link-created');
    return payloads.flatMap((payload) => {
      const blocker = issueKey(payload.blocker);
      const blocked = issueKey(payload.blocked);
      return blocker && blocked ? [{ blocker, blocked }] : [];
    });
  },
  async sprintDemoBugs(projectKeys) {
    const valid = projectKeys.filter((key) => PROJECT_KEY.test(key));
    if (valid.length === 0) return [];
    const issues = await searchIssues(
      `project in (${valid.map((key) => `"${key}"`).join(', ')}) AND labels in ("${DEMO_BUG_LABEL}", "${LEGACY_DEMO_BUG_LABEL}") ` +
        'AND statusCategory != Done AND sprint in openSprints()',
      100,
    );
    return issues.map((issue) => issue.key);
  },
  moveToBacklog: moveIssuesToBacklog,
  async moveToSprint(sprintId, keys) {
    if (!SPRINT_ID.test(sprintId)) throw new Error(`Invalid sprint id "${sprintId}"`);
    await moveIssuesToSprint(Number(sprintId), keys);
  },
  async shiftOrigins(requestIds) {
    type Row = { id: number; issue_key: string; from_sprint_id: string | null; to_sprint_id: string | null; has_target: number | null };
    // has_target NULL: recorded before shift_targets existed, the destination is unknown.
    const query = `SELECT s.id, s.issue_key, s.from_sprint_id, t.to_sprint_id, CASE WHEN t.issue_key IS NULL THEN NULL ELSE 1 END AS has_target
      FROM shift_origins s LEFT JOIN shift_targets t ON t.request_id = s.request_id AND t.issue_key = s.issue_key`;
    // Records whose request is gone: an earlier clean could not move the issue back and keeps them for a retry.
    const rows = await select<Row>(`${query} WHERE NOT EXISTS (SELECT 1 FROM requests r WHERE r.id = s.request_id)`);
    for (const ids of chunks(requestIds)) {
      rows.push(...(await select<Row>(`${query} WHERE s.request_id IN (${marks(ids)})`, [...ids])));
    }
    const result = [];
    for (const row of rows) {
      const key = issueKey(row.issue_key);
      const from = row.from_sprint_id === null ? null : String(row.from_sprint_id);
      const to = row.has_target === null ? undefined : row.to_sprint_id === null ? null : String(row.to_sprint_id);
      // A malformed sprint id is skipped rather than guessed (fail closed).
      if (!key || (from !== null && !SPRINT_ID.test(from)) || (typeof to === 'string' && !SPRINT_ID.test(to))) continue;
      result.push({ id: Number(row.id), issueKey: key, fromSprintId: from, toSprintId: to });
    }
    return result.sort((a, b) => a.id - b.id);
  },
  async issuesInSprint(sprintId) {
    if (!SPRINT_ID.test(sprintId)) return new Set();
    try {
      return new Set((await listSprintIssues(Number(sprintId))).map((issue) => issue.key));
    } catch (error) {
      if (isNotFound(error)) return new Set();
      throw error;
    }
  },
  async inOpenSprints(keys) {
    const valid = [...new Set(keys)].filter((key) => ISSUE_KEY.test(key));
    if (valid.length === 0) return new Set();
    const issues = await searchIssues(`key in (${valid.join(',')}) AND sprint in openSprints()`, valid.length);
    return new Set(issues.map((issue) => issue.key));
  },
  async sprintArchivedDeliverables(projectKeys) {
    const valid = projectKeys.filter((key) => PROJECT_KEY.test(key));
    if (valid.length === 0) return [];
    const issues = await searchIssues(
      `project in (${valid.map((key) => `"${key}"`).join(', ')}) AND labels = "${ARCHIVED_LABEL}" AND sprint in openSprints()`,
      100,
    );
    return issues.map((issue) => issue.key);
  },
  async linkSuggestions(teamIds) {
    const rows = await select<{ id: number; blocked_issue_key: string; blocker_issue_key: string }>(
      `SELECT id, blocked_issue_key, blocker_issue_key FROM link_suggestions
       WHERE requester_team_id IN (${marks(teamIds)}) AND provider_team_id IN (${marks(teamIds)})`,
      [...teamIds, ...teamIds],
    );
    return rows.flatMap((row) => {
      const blocked = issueKey(row.blocked_issue_key);
      const blocker = issueKey(row.blocker_issue_key);
      return blocked && blocker ? [{ id: Number(row.id), blockedIssueKey: blocked, blockerIssueKey: blocker }] : [];
    });
  },
  async sprintState(sprintId) {
    if (!SPRINT_ID.test(sprintId)) return null;
    try {
      return (await getSprint(Number(sprintId))).state;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async issueState(key) {
    try {
      const issue = await getIssue(key);
      return { labels: issue.fields.labels ?? [], done: issue.fields.status?.statusCategory?.key === 'done' };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async archiveDeliverable(key, done) {
    await addIssueLabel(key, ARCHIVED_LABEL);
    if (done) return 'done';
    try {
      if (await transitionToDone(key)) return 'done';
    } catch (error) {
      // A workflow that needs screen fields for Done: the issue leaves the sprint instead.
      if (!(error instanceof AtlassianApiError) || error.status !== 400) throw error;
      console.error(`Accord demo clean: Done transition of ${key} refused`, error.detail.slice(0, 300));
    }
    await moveIssuesToBacklog([key]);
    return 'backlog';
  },
  async blocksLinkIds(blocker, blocked) {
    try {
      return (await listIssueLinks(blocker))
        .filter((link) => isBlocksFrom(link, blocked))
        .map((link) => link.id)
        .filter((id): id is string => typeof id === 'string' && /^[0-9]+$/.test(id));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },
  async deleteLink(linkId) {
    try {
      await deleteIssueLink(linkId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
  appAccountId,
  async commentedIssues() {
    // Comment markers (`comment:*`, monitor `notify:*`, `escalated`) all carry the commented issueKey.
    const rows = await select<{ payload: unknown }>(
      `SELECT payload FROM audit_log WHERE entity_type IN ('request', 'contract')
       AND (action LIKE 'comment:%' OR action LIKE 'notify:%' OR action = 'escalated')`,
    );
    const keys = rows.map((row) => issueKey(parseJson<Record<string, unknown>>(row.payload, {}).issueKey));
    return [...new Set(keys.filter((key): key is string => key !== null))];
  },
  async listComments(key) {
    try {
      return await listIssueComments(key);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },
  async deleteComment(key, commentId) {
    if (!/^[0-9]+$/.test(commentId)) return;
    try {
      await deleteIssueComment(key, commentId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },
  async deleteRows({ requestIds, contractIds, teamIds, shiftOriginIds, reopenSuggestionIds }) {
    for (const ids of chunks(shiftOriginIds)) await run(`DELETE FROM shift_origins WHERE id IN (${marks(ids)})`, [...ids]);
    if (shiftOriginIds.length > 0) {
      await run(
        `DELETE FROM shift_targets WHERE NOT EXISTS
         (SELECT 1 FROM shift_origins s WHERE s.request_id = shift_targets.request_id AND s.issue_key = shift_targets.issue_key)`,
      );
    }
    for (const ids of chunks(contractIds)) {
      await run(`DELETE FROM contract_notifications WHERE contract_id IN (${marks(ids)})`, [...ids]);
      await run(`DELETE FROM dependency_edges WHERE contract_id IN (${marks(ids)})`, [...ids]);
    }
    for (const ids of chunks(requestIds)) {
      const params = [...ids];
      await run(`DELETE FROM options WHERE request_id IN (${marks(ids)})`, params);
      await run(`DELETE FROM negotiation_rounds WHERE request_id IN (${marks(ids)})`, params);
      await run(`DELETE FROM approvals WHERE request_id IN (${marks(ids)})`, params);
      await run(`DELETE FROM renegotiations WHERE request_id IN (${marks(ids)}) OR parent_request_id IN (${marks(ids)})`, [...ids, ...ids]);
      await run(`DELETE FROM contracts WHERE request_id IN (${marks(ids)})`, params);
      await run(`DELETE FROM requests WHERE id IN (${marks(ids)})`, params);
    }
    if (teamIds.length === 0) return { suggestions: 0 };
    // Suggestions whose link still exists are shown again on the blocked issue; the request they led to is gone.
    for (const ids of chunks(reopenSuggestionIds)) {
      await run(
        `UPDATE link_suggestions SET status = 'open', request_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id IN (${marks(ids)})`,
        [...ids],
      );
    }
    const keep = reopenSuggestionIds.length ? ` AND id NOT IN (${marks(reopenSuggestionIds)})` : '';
    const deleted = await run(
      `DELETE FROM link_suggestions WHERE requester_team_id IN (${marks(teamIds)}) AND provider_team_id IN (${marks(teamIds)})${keep}`,
      [...teamIds, ...teamIds, ...reopenSuggestionIds],
    );
    return { suggestions: Number(deleted.affectedRows ?? 0) };
  },
  audit: (action, actor, payload) => audit('demo', 'clean', action, actor, payload),
};
