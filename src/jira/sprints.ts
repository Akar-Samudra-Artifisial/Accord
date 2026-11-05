import { route } from '@forge/api';
import { jira } from '../atlassian/http';
import type { Sprint } from '../planner';

export interface JiraSprint {
  id: number;
  name: string;
  state: 'closed' | 'active' | 'future';
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

interface SprintPage {
  values: JiraSprint[];
  isLast: boolean;
}

const MAX_PAGES = 20;

export async function listSprints(
  boardId: number,
  states: ReadonlyArray<JiraSprint['state']> = ['closed', 'active', 'future'],
): Promise<JiraSprint[]> {
  const result: JiraSprint[] = [];
  const state = states.join(',');
  for (let page = 0, startAt = 0; page < MAX_PAGES; page += 1) {
    const response = await jira<SprintPage>(
      route`/rest/agile/1.0/board/${boardId}/sprint?state=${state}&startAt=${startAt}&maxResults=50`,
    );
    result.push(...response.values);
    if (response.isLast || response.values.length === 0) break;
    startAt += response.values.length;
  }
  return result;
}

export async function createSprint(
  boardId: number,
  name: string,
  startDate?: string,
  endDate?: string,
): Promise<JiraSprint> {
  return jira<JiraSprint>(route`/rest/agile/1.0/sprint`, {
    method: 'POST',
    body: { name, originBoardId: boardId, startDate, endDate },
  });
}

/** Partial update (POST): rename, re-date or start (`state: 'active'`) a sprint. */
export async function updateSprint(
  sprintId: number,
  patch: { name?: string; startDate?: string; endDate?: string; state?: 'active' },
): Promise<JiraSprint> {
  return jira<JiraSprint>(route`/rest/agile/1.0/sprint/${sprintId}`, { method: 'POST', body: patch });
}

export async function getSprint(sprintId: number): Promise<JiraSprint> {
  return jira<JiraSprint>(route`/rest/agile/1.0/sprint/${sprintId}`);
}

export async function moveIssuesToSprint(sprintId: number, issueKeys: readonly string[]): Promise<void> {
  // The Agile API accepts at most 50 issues per call.
  for (let i = 0; i < issueKeys.length; i += 50) {
    await jira<void>(route`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: 'POST',
      body: { issues: issueKeys.slice(i, i + 50) },
    });
  }
}

/** Jira timestamps → planner calendar dates (UTC). */
export function toPlannerSprint(sprint: JiraSprint): Sprint | null {
  if (!sprint.startDate || !sprint.endDate) return null;
  return {
    id: String(sprint.id),
    name: sprint.name,
    startDate: sprint.startDate.slice(0, 10),
    endDate: sprint.endDate.slice(0, 10),
    state: sprint.state,
  };
}

export async function moveIssuesToBacklog(issueKeys: readonly string[]): Promise<void> {
  for (let i = 0; i < issueKeys.length; i += 50) {
    await jira<void>(route`/rest/agile/1.0/backlog/issue`, { method: 'POST', body: { issues: issueKeys.slice(i, i + 50) } });
  }
}
