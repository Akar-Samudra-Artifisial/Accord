import { route } from '@forge/api';
import { jira } from '../atlassian/http';

export interface Board {
  id: number;
  name: string;
  type: 'scrum' | 'kanban' | 'simple' | string;
}

interface BoardPage {
  values: Board[];
  isLast?: boolean;
}

/** All boards whose location is the given project. */
export async function listProjectBoards(projectKey: string): Promise<Board[]> {
  const page = await jira<BoardPage>(
    route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
  );
  return page.values.map(({ id, name, type }) => ({ id, name, type }));
}

export type BoardLookup = { status: 'ok'; board: Board } | { status: 'no-scrum-board'; boards: Board[] };

/**
 * Accord plans in sprints, so a team needs a Scrum board.
 * Kanban-only projects are rejected with an explicit reason.
 */
export async function findScrumBoard(projectKey: string): Promise<BoardLookup> {
  const boards = await listProjectBoards(projectKey);
  const scrum = boards.find((board) => board.type === 'scrum');
  return scrum ? { status: 'ok', board: scrum } : { status: 'no-scrum-board', boards };
}
