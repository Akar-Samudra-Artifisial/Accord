import { route } from '@forge/api';
import { jira, type Principal } from '../atlassian/http';

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
export async function searchIssues(jql: string, maxIssues = 500, as: Principal = 'app'): Promise<JiraIssue[]> {
  const result: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && result.length < maxIssues; page += 1) {
    const response = await jira<SearchPage>(route`/rest/api/3/search/jql`, {
      method: 'POST',
      as,
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

/** Issue keys must look like `ABC-123`; validated before they reach JQL or a route. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]*$/;

export async function getIssue(key: string, as: Principal = 'app'): Promise<JiraIssue> {
  const fields = ISSUE_FIELDS.join(',');
  return jira<JiraIssue>(route`/rest/api/3/issue/${key}?fields=${fields}`, { as });
}

/** Keys per `key in (...)` query: keeps the JQL short and each search to one page. */
export const VISIBLE_KEYS_BATCH = 100;

/** Subset of `keys` the principal may browse (NFR-3). Deduplicated, then checked in batches of 100. */
export async function visibleIssueKeys(keys: readonly string[], as: Principal): Promise<Set<string>> {
  const valid = [...new Set(keys)].filter((key) => ISSUE_KEY.test(key));
  const visible = new Set<string>();
  for (let start = 0; start < valid.length; start += VISIBLE_KEYS_BATCH) {
    const batch = valid.slice(start, start + VISIBLE_KEYS_BATCH);
    for (const issue of await searchIssues(`key in (${batch.join(',')})`, batch.length, as)) visible.add(issue.key);
  }
  return visible;
}

export async function createIssue(issue: NewIssue): Promise<string> {
  const response = await jira<{ key: string }>(route`/rest/api/3/issue`, {
    method: 'POST',
    body: {
      fields: {
        project: { key: issue.projectKey },
        summary: issue.summary,
        issuetype: { name: issue.issueType },
        priority: { name: issue.priority },
        labels: issue.labels,
        ...(issue.dueDate ? { duedate: issue.dueDate } : {}),
      },
    },
  });
  return response.key;
}

/**
 * Plain-text comment rendered as one ADF paragraph per line. Optional `mentions` (account ids,
 * validated by the caller) are added as a leading paragraph of ADF mention nodes.
 */
export async function addComment(issueKey: string, text: string, mentions: readonly string[] = []): Promise<string> {
  const lines = text.split('\n').map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
  const mentionNodes = mentions.flatMap((id, index) => [
    ...(index > 0 ? [{ type: 'text', text: ' ' }] : []),
    { type: 'mention', attrs: { id } },
  ]);
  const content = mentionNodes.length > 0 ? [{ type: 'paragraph', content: mentionNodes }, ...lines] : lines;
  const response = await jira<{ id: string }>(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    body: { body: { type: 'doc', version: 1, content } },
  });
  return response.id;
}

/** Sets the due date of an existing issue (as the app). */
export async function updateDueDate(issueKey: string, dueDate: string): Promise<void> {
  await jira(route`/rest/api/3/issue/${issueKey}`, { method: 'PUT', body: { fields: { duedate: dueDate } } });
}

/** Display name of an Atlassian account (as the app, scope read:jira-user). */
export async function userDisplayName(accountId: string): Promise<string | null> {
  const user = await jira<{ displayName?: string }>(route`/rest/api/3/user?accountId=${accountId}`);
  return user.displayName?.trim() || null;
}

export interface IssueLink {
  id?: string;
  type: { name: string; inward?: string; outward?: string };
  inwardIssue?: { key: string };
  outwardIssue?: { key: string };
}

export async function listIssueLinks(issueKey: string): Promise<IssueLink[]> {
  const issue = await jira<{ fields: { issuelinks?: IssueLink[] } }>(
    route`/rest/api/3/issue/${issueKey}?fields=issuelinks`,
  );
  return issue.fields.issuelinks ?? [];
}

/**
 * `link` was read from the blocker's `issuelinks`. Jira's issue linking model: an entry with
 * `outwardIssue` is shown with the outward label ("blocks"), i.e. "<this issue> blocks <outwardIssue>".
 * An entry with `inwardIssue` means the opposite direction ("is blocked by") and does not count.
 */
export function isBlocksFrom(link: IssueLink, blocked: string): boolean {
  return link.type.name === 'Blocks' && link.outwardIssue?.key === blocked;
}

/**
 * Creates "`blocker` blocks `blocked`" (built-in Blocks link type). POST /rest/api/3/issueLink stores the
 * `inwardIssue` as the link source, which reads with the outward label ("blocks") — verified on the
 * development site during M3 (see "Blocks direction" in docs/spikes.md).
 */
export async function linkBlocks(blocker: string, blocked: string): Promise<void> {
  await jira<void>(route`/rest/api/3/issueLink`, {
    method: 'POST',
    body: { type: { name: 'Blocks' }, inwardIssue: { key: blocker }, outwardIssue: { key: blocked } },
  });
}

/** Adds one label to an issue (as the app); a label that is already there is left as is. */
export async function addIssueLabel(issueKey: string, label: string): Promise<void> {
  await jira<void>(route`/rest/api/3/issue/${issueKey}`, { method: 'PUT', body: { update: { labels: [{ add: label }] } } });
}

interface IssueTransitions {
  transitions: Array<{ id: string; to?: { statusCategory?: { key?: string } } }>;
}

/** Moves the issue through the first transition that ends in the Done category; false when there is none. */
export async function transitionToDone(issueKey: string): Promise<boolean> {
  const { transitions } = await jira<IssueTransitions>(route`/rest/api/3/issue/${issueKey}/transitions`);
  const done = transitions.find((transition) => transition.to?.statusCategory?.key === 'done');
  if (!done) return false;
  await jira<void>(route`/rest/api/3/issue/${issueKey}/transitions`, { method: 'POST', body: { transition: { id: done.id } } });
  return true;
}

/** Account id of the app user (as the app); null when Jira does not report an app account. */
export async function appAccountId(): Promise<string | null> {
  const me = await jira<{ accountId?: string; accountType?: string }>(route`/rest/api/3/myself`);
  return me.accountType === 'app' && typeof me.accountId === 'string' && me.accountId ? me.accountId : null;
}

interface CommentPage {
  comments: Array<{ id: string; author?: { accountId?: string } }>;
  total: number;
}

/** All comments of an issue (as the app) with their author account id. */
export async function listIssueComments(issueKey: string): Promise<Array<{ id: string; authorAccountId: string | null }>> {
  const result: Array<{ id: string; authorAccountId: string | null }> = [];
  for (let page = 0, startAt = 0; page < MAX_PAGES; page += 1) {
    const response = await jira<CommentPage>(route`/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=100`);
    result.push(...response.comments.map((comment) => ({ id: comment.id, authorAccountId: comment.author?.accountId ?? null })));
    startAt += response.comments.length;
    if (response.comments.length === 0 || startAt >= response.total) break;
  }
  return result;
}

export async function deleteIssueComment(issueKey: string, commentId: string): Promise<void> {
  await jira<void>(route`/rest/api/3/issue/${issueKey}/comment/${commentId}`, { method: 'DELETE' });
}

export async function deleteIssueLink(linkId: string): Promise<void> {
  await jira<void>(route`/rest/api/3/issueLink/${linkId}`, { method: 'DELETE' });
}
