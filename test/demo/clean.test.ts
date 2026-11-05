import { beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVED_LABEL, MAX_COMMENTS_PER_RUN, cleanDemoData, type CleanContractRow, type CleanRequestRow, type DemoCleanPort } from '../../src/demo/clean';
import { UserFacingError } from '../../src/errors';

interface FakeIssue {
  labels: string[];
  done: boolean;
  inSprint: boolean;
  demoBug: boolean;
}

/** In-memory site: ACMOB/ACPAY belong to Accord, MOB/PAY to somebody else. */
class FakeCleanPort implements DemoCleanPort {
  projects = [
    { projectKey: 'ACMOB', name: 'Mobile' },
    { projectKey: 'ACPAY', name: 'Payments' },
  ];
  teams: Record<string, string> = { ACMOB: 'team-mob', ACPAY: 'team-pay', MOB: 'team-foreign' };
  requests: CleanRequestRow[] = [];
  contracts: CleanContractRow[] = [];
  deliverableAudit = new Map<number, string>();
  linkAudit = new Map<number, { blocker: string; blocked: string }>();
  issues = new Map<string, FakeIssue>();
  links = new Map<string, { blocker: string; blocked: string }>();
  suggestions = 0;
  writes: string[] = [];
  audits: Array<{ action: string; payload: unknown }> = [];

  async accordProjects() {
    return this.projects;
  }
  async teamIdOf(projectKey: string) {
    return this.teams[projectKey] ?? null;
  }
  async requestsBetween(teamIds: readonly string[]) {
    return this.requests.filter((r) => teamIds.includes(r.requesterTeamId) && teamIds.includes(r.providerTeamId));
  }
  async contractsOf(requestIds: readonly string[]) {
    return this.contracts.filter((c) => requestIds.includes(c.requestId));
  }
  async recordedDeliverables(contractIds: readonly number[]) {
    return new Set(contractIds.flatMap((id) => (this.deliverableAudit.has(id) ? [this.deliverableAudit.get(id) as string] : [])));
  }
  async recordedLinks(contractIds: readonly number[]) {
    return contractIds.flatMap((id) => (this.linkAudit.has(id) ? [this.linkAudit.get(id) as { blocker: string; blocked: string }] : []));
  }
  // Deliberately returns foreign keys too: the clean must filter them out itself.
  async sprintDemoBugs() {
    return [...this.issues.entries()].filter(([, issue]) => issue.demoBug && issue.inSprint).map(([key]) => key);
  }
  async moveToBacklog(issueKeys: readonly string[]) {
    for (const key of issueKeys) {
      this.writes.push(`backlog:${key}`);
      const issue = this.issues.get(key);
      if (issue) issue.inSprint = false;
    }
  }
  async issueState(issueKey: string) {
    const issue = this.issues.get(issueKey);
    return issue ? { labels: [...issue.labels], done: issue.done } : null;
  }
  async archiveDeliverable(issueKey: string) {
    this.writes.push(`archive:${issueKey}`);
    const issue = this.issues.get(issueKey) as FakeIssue;
    issue.labels.push(ARCHIVED_LABEL);
    issue.done = true;
    return 'done' as const;
  }
  async blocksLinkIds(blocker: string, blocked: string) {
    return [...this.links.entries()].filter(([, l]) => l.blocker === blocker && l.blocked === blocked).map(([id]) => id);
  }
  async deleteLink(linkId: string) {
    this.writes.push(`unlink:${linkId}`);
    this.links.delete(linkId);
  }
  appId: string | null = 'app-accord';
  commentMarkers: string[] = [];
  comments = new Map<string, Array<{ id: string; authorAccountId: string | null }>>();
  async appAccountId() {
    return this.appId;
  }
  async commentedIssues() {
    return this.commentMarkers;
  }
  async listComments(issueKey: string) {
    return [...(this.comments.get(issueKey) ?? [])];
  }
  async deleteComment(issueKey: string, commentId: string) {
    this.writes.push(`uncomment:${issueKey}:${commentId}`);
    this.comments.set(issueKey, (this.comments.get(issueKey) ?? []).filter((c) => c.id !== commentId));
  }
  async deleteRows(scope: { requestIds: readonly string[]; contractIds: readonly number[] }) {
    this.requests = this.requests.filter((r) => !scope.requestIds.includes(r.id));
    this.contracts = this.contracts.filter((c) => !scope.contractIds.includes(c.id));
    const suggestions = this.suggestions;
    this.suggestions = 0;
    return { suggestions };
  }
  async audit(action: string, _actor: string | null, payload: unknown) {
    this.audits.push({ action, payload });
  }
}

const admin = async () => true;

describe('cleanDemoData', () => {
  let port: FakeCleanPort;

  beforeEach(() => {
    port = new FakeCleanPort();
    port.requests = [
      { id: 'r1', requesterTeamId: 'team-mob', providerTeamId: 'team-pay' },
      { id: 'r-foreign', requesterTeamId: 'team-foreign', providerTeamId: 'team-pay' },
    ];
    port.contracts = [
      { id: 1, requestId: 'r1', deliverableIssueKey: 'ACPAY-18' },
      { id: 2, requestId: 'r-foreign', deliverableIssueKey: 'ACPAY-30' },
    ];
    port.deliverableAudit.set(1, 'ACPAY-18');
    port.linkAudit.set(1, { blocker: 'ACPAY-18', blocked: 'ACMOB-4' });
    port.issues.set('ACPAY-18', { labels: ['accord', 'accord-r1'], done: false, inSprint: true, demoBug: false });
    port.issues.set('ACPAY-30', { labels: ['accord'], done: false, inSprint: true, demoBug: false });
    port.issues.set('ACPAY-40', { labels: ['accord-demo-bug'], done: false, inSprint: true, demoBug: true });
    port.issues.set('ACPAY-41', { labels: ['accord-demo-bug'], done: false, inSprint: true, demoBug: true });
    port.issues.set('PAY-7', { labels: ['accord-demo-bug'], done: false, inSprint: true, demoBug: true });
    port.links.set('L1', { blocker: 'ACPAY-18', blocked: 'ACMOB-4' });
    port.links.set('L-foreign', { blocker: 'PAY-1', blocked: 'MOB-2' });
    port.suggestions = 3;
    port.commentMarkers = ['ACMOB-3', 'ACPAY-21', 'ACMOB-3', 'MOB-9'];
    port.comments.set('ACMOB-3', [
      { id: '10', authorAccountId: 'app-accord' },
      { id: '11', authorAccountId: 'human-1' },
      { id: '12', authorAccountId: 'app-accord' },
    ]);
    port.comments.set('ACPAY-21', [{ id: '20', authorAccountId: 'app-accord' }, { id: '21', authorAccountId: 'app-other' }]);
    port.comments.set('MOB-9', [{ id: '90', authorAccountId: 'app-accord' }]);
  });

  it('removes only comments of the Accord app on Accord issues', async () => {
    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.commentsRemoved).toBe(3);
    expect(port.comments.get('ACMOB-3')?.map((c) => c.id)).toEqual(['11']);
    expect(port.comments.get('ACPAY-21')?.map((c) => c.id)).toEqual(['21']);
    expect(port.comments.get('MOB-9')?.map((c) => c.id)).toEqual(['90']);
  });

  it('caps comment deletions per run and finishes them on the next run', async () => {
    const many = Array.from({ length: MAX_COMMENTS_PER_RUN + 5 }, (_, i) => ({ id: String(1000 + i), authorAccountId: 'app-accord' }));
    port.comments.set('ACMOB-3', [...many, { id: '11', authorAccountId: 'human-1' }]);
    port.comments.set('ACPAY-21', []);

    const first = await cleanDemoData(port, 'user-1', admin);
    expect(first.commentsRemoved).toBe(MAX_COMMENTS_PER_RUN);
    expect(first.summary).toMatch(/run Clean demo data again/);
    expect(port.requests.map((r) => r.id)).toEqual(['r-foreign']);

    const second = await cleanDemoData(port, 'user-1', admin);
    expect(second.commentsRemoved).toBe(5);
    expect(second.summary).not.toMatch(/again/);
    expect(port.comments.get('ACMOB-3')?.map((c) => c.id)).toEqual(['11']);
  });

  it('removes no comment when the app account cannot be confirmed', async () => {
    port.appId = null;
    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.commentsRemoved).toBe(0);
    expect(port.writes.some((write) => write.startsWith('uncomment:'))).toBe(false);
    expect(result.notRestored[0]).toMatch(/no comments were removed/);
  });

  it('rejects a user who cannot manage every demo project and writes nothing', async () => {
    const canManage = async (projectKey: string) => projectKey !== 'ACPAY';
    await expect(cleanDemoData(port, 'user-1', canManage)).rejects.toBeInstanceOf(UserFacingError);
    expect(port.writes).toEqual([]);
    expect(port.requests).toHaveLength(2);
    expect(port.audits).toEqual([]);
  });

  it('touches only Accord projects and requests between Accord demo teams', async () => {
    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.projects).toEqual(['ACMOB', 'ACPAY']);
    expect(result.summary).toBe('Cleaned: 1 request, 1 contract, 1 link, 2 bugs reset, 3 comments removed');
    expect(result.deliverablesArchived).toBe(1);
    expect(result.suggestions).toBe(3);
    expect(port.writes.every((write) => /:(ACMOB|ACPAY)-|^unlink:L1$/.test(write))).toBe(true);
    expect(port.writes.some((write) => write.includes('MOB-9') && !write.includes('ACMOB'))).toBe(false);
    expect(port.writes).not.toContain('backlog:PAY-7');
    expect(port.links.has('L-foreign')).toBe(true);
    expect(port.issues.get('PAY-7')?.inSprint).toBe(true);
    // A request with a non-demo team is kept, so is its deliverable.
    expect(port.requests.map((r) => r.id)).toEqual(['r-foreign']);
    expect(port.issues.get('ACPAY-30')?.labels).not.toContain(ARCHIVED_LABEL);
    expect(port.issues.get('ACPAY-18')?.labels).toContain(ARCHIVED_LABEL);
    expect(port.audits.map((a) => a.action)).toEqual(['demo-cleaned']);
  });

  it('is idempotent: a second run reports zeros and writes nothing to Jira', async () => {
    await cleanDemoData(port, 'user-1', admin);
    port.writes = [];

    const again = await cleanDemoData(port, 'user-1', admin);

    expect(again.summary).toBe('Cleaned: 0 requests, 0 contracts, 0 links, 0 bugs reset, 0 comments removed');
    expect(again.deliverablesArchived).toBe(0);
    expect(port.writes).toEqual([]);
  });

  it('skips deliverables Accord did not create', async () => {
    port.deliverableAudit.clear();
    port.issues.set('ACPAY-18', { labels: [], done: false, inSprint: true, demoBug: false });

    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.deliverablesArchived).toBe(0);
    expect(port.writes).not.toContain('archive:ACPAY-18');
  });
});
