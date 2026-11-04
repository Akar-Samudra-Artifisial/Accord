import { route } from '@forge/api';
import { jira } from '../atlassian/http';

export const ISSUE_FIELDS = ['summary', 'labels', 'issuetype', 'priority', 'duedate', 'status', 'parent'] as const;

/** Raw Jira issue shape restricted to ISSUE_FIELDS. */
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    labels?: string[];
    issuetype?: { name: string } | null;
    priority?: { name: string } | null;
    duedate?: string | null;
    status?: { name: string; statusCategory?: { key: string } } | null;
    parent?: { key: string } | null;
  };
}

interface AgileIssuePage {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

const MAX_PAGES = 20;

export async function listSprintIssues(sprintId: number): Promise<JiraIssue[]> {
  const fields = ISSUE_FIELDS.join(',');
  const result: JiraIssue[] = [];
  for (let page = 0, startAt = 0; page < MAX_PAGES; page += 1) {
    const response = await jira<AgileIssuePage>(
      route`/rest/agile/1.0/sprint/${sprintId}/issue?fields=${fields}&startAt=${startAt}&maxResults=100`,
    );
    result.push(...response.issues);
    startAt += response.issues.length;
    if (response.issues.length === 0 || startAt >= response.total) break;
  }
  return result;
}

interface SearchPage {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Enhanced JQL search (`/rest/api/3/search/jql`), token paginated. */
export async function searchIssues(jql: string, maxIssues = 500): Promise<JiraIssue[]> {
  const result: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && result.length < maxIssues; page += 1) {
    const response = await jira<SearchPage>(route`/rest/api/3/search/jql`, {
      method: 'POST',
      body: { jql, fields: [...ISSUE_FIELDS], maxResults: 100, nextPageToken },
    });
    result.push(...response.issues);
    nextPageToken = response.nextPageToken;
    if (response.isLast !== false || !nextPageToken) break;
  }
  return result.slice(0, maxIssues);
}

export interface NewIssue {
  projectKey: string;
  summary: string;
  issueType: string;
  priority: string;
  labels: string[];
  dueDate?: string;
}

interface BulkCreateResponse {
  issues: Array<{ id: string; key: string }>;
  errors: Array<{ failedElementNumber: number; elementErrors: { errors?: Record<string, string>; errorMessages?: string[] } }>;
}

export async function createIssues(issues: readonly NewIssue[]): Promise<string[]> {
  const response = await jira<BulkCreateResponse>(route`/rest/api/3/issue/bulk`, {
    method: 'POST',
    body: {
      issueUpdates: issues.map((issue) => ({
        fields: {
          project: { key: issue.projectKey },
          summary: issue.summary,
          issuetype: { name: issue.issueType },
          priority: { name: issue.priority },
          labels: issue.labels,
          ...(issue.dueDate ? { duedate: issue.dueDate } : {}),
        },
      })),
    },
  });
  if (response.errors?.length) {
    throw new Error(`Jira rejected ${response.errors.length} issue(s): ${JSON.stringify(response.errors).slice(0, 400)}`);
  }
  return response.issues.map((issue) => issue.key);
}
