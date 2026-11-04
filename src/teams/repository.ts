import { parseJson, run, select } from '../sql/db';
import type { Charter, Rule } from '../planner';
import type { ThroughputSample } from '../capacity/aggregate';
import type { CharterValidation } from '../confluence/charter';

export interface Team {
  id: string;
  teamKey: string;
  name: string;
  jiraProjectKey: string;
  boardId: number | null;
  leadAccountId: string | null;
  charterPageId: string | null;
}

interface TeamRow {
  id: string;
  team_key: string;
  name: string;
  jira_project_key: string;
  board_id: number | string | null;
  lead_account_id: string | null;
  charter_page_id: string | null;
}

const toTeam = (row: TeamRow): Team => ({
  id: row.id,
  teamKey: row.team_key,
  name: row.name,
  jiraProjectKey: row.jira_project_key,
  boardId: row.board_id === null ? null : Number(row.board_id),
  leadAccountId: row.lead_account_id,
  charterPageId: row.charter_page_id,
});

export const teamIdFor = (projectKey: string) => `team-${projectKey}`;

export async function upsertTeam(team: Omit<Team, 'id'>): Promise<Team> {
  const id = teamIdFor(team.jiraProjectKey);
  await run(
    `INSERT INTO teams (id, team_key, name, jira_project_key, board_id, lead_account_id, charter_page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), board_id = VALUES(board_id),
       lead_account_id = COALESCE(VALUES(lead_account_id), lead_account_id),
       charter_page_id = COALESCE(VALUES(charter_page_id), charter_page_id)`,
    [id, team.teamKey, team.name, team.jiraProjectKey, team.boardId, team.leadAccountId, team.charterPageId],
  );
  return { id, ...team };
}

export async function setCharterPage(teamId: string, pageId: string): Promise<void> {
  await run('UPDATE teams SET charter_page_id = ? WHERE id = ?', [pageId, teamId]);
}

export async function listTeams(): Promise<Team[]> {
  return (await select<TeamRow>('SELECT * FROM teams ORDER BY team_key')).map(toTeam);
}

export async function getTeamByKey(teamKey: string): Promise<Team | null> {
  const rows = await select<TeamRow>('SELECT * FROM teams WHERE team_key = ?', [teamKey]);
  return rows[0] ? toTeam(rows[0]) : null;
}

export async function getTeamById(id: string): Promise<Team | null> {
  const rows = await select<TeamRow>('SELECT * FROM teams WHERE id = ?', [id]);
  return rows[0] ? toTeam(rows[0]) : null;
}

export async function getTeamByProjectKey(projectKey: string): Promise<Team | null> {
  const rows = await select<TeamRow>('SELECT * FROM teams WHERE jira_project_key = ?', [projectKey]);
  return rows[0] ? toTeam(rows[0]) : null;
}

export async function getTeamByCharterPage(pageId: string): Promise<Team | null> {
  const rows = await select<TeamRow>('SELECT * FROM teams WHERE charter_page_id = ?', [pageId]);
  return rows[0] ? toTeam(rows[0]) : null;
}

export interface StoredCharter {
  teamId: string;
  pageId: string;
  pageVersion: number;
  valid: boolean;
  missingFields: string[];
  charter: Charter | null;
  updatedAt: string;
}

interface CharterRow {
  team_id: string;
  page_id: string;
  page_version: number;
  valid: number | boolean;
  missing_fields: unknown;
  priorities: unknown;
  red_lines: unknown;
  shiftable: unknown;
  max_external_share: string | number | null;
  response_days: number | null;
  approvers: unknown;
  escalation_contact: string | null;
  updated_at: string;
}

export async function saveCharter(
  teamId: string,
  pageId: string,
  pageVersion: number,
  validation: CharterValidation,
): Promise<void> {
  const charter = validation.charter;
  await run(
    `INSERT INTO charters (team_id, page_id, page_version, valid, missing_fields, priorities, red_lines, shiftable,
       max_external_share, response_days, approvers, escalation_contact, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE page_id = VALUES(page_id), page_version = VALUES(page_version), valid = VALUES(valid),
       missing_fields = VALUES(missing_fields), priorities = VALUES(priorities), red_lines = VALUES(red_lines),
       shiftable = VALUES(shiftable), max_external_share = VALUES(max_external_share),
       response_days = VALUES(response_days), approvers = VALUES(approvers),
       escalation_contact = VALUES(escalation_contact), updated_at = CURRENT_TIMESTAMP`,
    [
      teamId,
      pageId,
      pageVersion,
      validation.valid,
      JSON.stringify(validation.missing),
      charter ? JSON.stringify(charter.priorities) : null,
      charter ? JSON.stringify(charter.redLines) : null,
      charter ? JSON.stringify(charter.shiftable) : null,
      charter ? charter.maxExternalShare : null,
      charter ? charter.responseDays : null,
      charter ? JSON.stringify(charter.approvers) : null,
      charter?.escalationContact ?? null,
    ],
  );
}

export async function getCharter(teamId: string): Promise<StoredCharter | null> {
  const rows = await select<CharterRow>('SELECT * FROM charters WHERE team_id = ?', [teamId]);
  const row = rows[0];
  if (!row) return null;
  const valid = Boolean(Number(row.valid));
  return {
    teamId: row.team_id,
    pageId: row.page_id,
    pageVersion: Number(row.page_version),
    valid,
    missingFields: parseJson<string[]>(row.missing_fields, []),
    updatedAt: String(row.updated_at),
    charter: valid
      ? {
          priorities: parseJson<string[]>(row.priorities, []),
          redLines: parseJson<Rule[]>(row.red_lines, []),
          shiftable: parseJson<Rule[]>(row.shiftable, []),
          maxExternalShare: Number(row.max_external_share),
          responseDays: Number(row.response_days),
          approvers: parseJson<string[]>(row.approvers, []),
          escalationContact: row.escalation_contact ?? undefined,
        }
      : null,
  };
}

interface SampleRow {
  sprint_id: string;
  sprint_name: string;
  completed_count: number;
  end_date: string;
  source: 'jira' | 'simulated';
}

export async function listThroughput(teamId: string): Promise<ThroughputSample[]> {
  const rows = await select<SampleRow>(
    'SELECT sprint_id, sprint_name, completed_count, end_date, source FROM throughput_samples WHERE team_id = ? ORDER BY end_date',
    [teamId],
  );
  return rows.map((row) => ({
    sprintId: row.sprint_id,
    sprintName: row.sprint_name,
    completedCount: Number(row.completed_count),
    endDate: String(row.end_date).slice(0, 10),
    source: row.source,
  }));
}

export async function saveThroughput(teamId: string, samples: readonly ThroughputSample[]): Promise<void> {
  for (const sample of samples) {
    await run(
      `INSERT INTO throughput_samples (team_id, sprint_id, sprint_name, completed_count, end_date, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sprint_name = VALUES(sprint_name), completed_count = VALUES(completed_count),
         end_date = VALUES(end_date), source = VALUES(source)`,
      [teamId, sample.sprintId, sample.sprintName, sample.completedCount, sample.endDate, sample.source],
    );
  }
}

export async function audit(
  entityType: string,
  entityId: string,
  action: string,
  actorAccountId: string | null,
  payload: unknown,
): Promise<void> {
  await run(
    'INSERT INTO audit_log (entity_type, entity_id, action, actor_account_id, payload) VALUES (?, ?, ?, ?, ?)',
    [entityType, entityId, action, actorAccountId, JSON.stringify(payload ?? null)],
  );
}
