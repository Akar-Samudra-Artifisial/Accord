import { route } from '@forge/api';
import { jira } from '../atlassian/http';
import { run, select } from '../sql/db';
import { audit, getTeamByProjectKey } from '../teams/repository';
import type { LinkSuggestion, LinkSuggestionDeps, SuggestionStatus, SuggestionStore } from './link-suggestions';

interface SuggestionRow {
  id: number;
  blocked_issue_key: string;
  blocker_issue_key: string;
  requester_team_id: string;
  provider_team_id: string;
  link_id: string | null;
  status: string;
  request_id: string | null;
}

function toSuggestion(row: SuggestionRow): LinkSuggestion {
  return {
    id: Number(row.id),
    blockedIssueKey: row.blocked_issue_key,
    blockerIssueKey: row.blocker_issue_key,
    requesterTeamId: row.requester_team_id,
    providerTeamId: row.provider_team_id,
    linkId: row.link_id,
    status: row.status as SuggestionStatus,
    requestId: row.request_id,
  };
}

/** Forge SQL store of `link_suggestions` (FR-16). */
export const sqlSuggestionStore: SuggestionStore = {
  async insert(suggestion) {
    const result = await run(
      `INSERT IGNORE INTO link_suggestions (blocked_issue_key, blocker_issue_key, requester_team_id, provider_team_id, link_id)
       VALUES (?, ?, ?, ?, ?)`,
      [suggestion.blockedIssueKey, suggestion.blockerIssueKey, suggestion.requesterTeamId, suggestion.providerTeamId, suggestion.linkId],
    );
    return Number(result.affectedRows) > 0 ? 'inserted' : 'exists';
  },
  async byPair(blockedIssueKey, blockerIssueKey) {
    const rows = await select<SuggestionRow>('SELECT * FROM link_suggestions WHERE blocked_issue_key = ? AND blocker_issue_key = ?', [
      blockedIssueKey,
      blockerIssueKey,
    ]);
    return rows[0] ? toSuggestion(rows[0]) : null;
  },
  async get(id) {
    const rows = await select<SuggestionRow>('SELECT * FROM link_suggestions WHERE id = ?', [id]);
    return rows[0] ? toSuggestion(rows[0]) : null;
  },
  async openFor(blockedIssueKey) {
    const rows = await select<SuggestionRow>(
      "SELECT * FROM link_suggestions WHERE blocked_issue_key = ? AND status = 'open' ORDER BY id DESC LIMIT 20",
      [blockedIssueKey],
    );
    return rows.map(toSuggestion);
  },
  async close(id, status, requestId) {
    const result = await run(
      "UPDATE link_suggestions SET status = ?, request_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'",
      [status, requestId, id],
    );
    return Number(result.affectedRows) > 0;
  },
  audit,
};

/** Issue key by numeric id, as the app; null when Jira does not know the issue. */
async function issueKeyById(issueId: string): Promise<string | null> {
  try {
    const issue = await jira<{ key?: string }>(route`/rest/api/3/issue/${issueId}?fields=summary`);
    return issue.key ?? null;
  } catch (error) {
    // Not only "not found": a transient Jira error also lands here and the link is then ignored (not retried).
    console.error(
      `[issuelink] issue ${issueId} could not be read as the app (deleted, no access or transient Jira error); link ignored`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export const productionSuggestionDeps: LinkSuggestionDeps = {
  store: sqlSuggestionStore,
  issueKey: issueKeyById,
  teamByProjectKey: getTeamByProjectKey,
};
