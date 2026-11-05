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
  /** Issues Jira refuses to move; a batch containing one fails as a whole, like the Agile API. */
  failMoves = new Set<string>();
  /** Open sprint each issue sits in (absent/null = backlog). */
  sprintOf = new Map<string, string | null>();
  private refuse(issueKeys: readonly string[]) {
    const bad = issueKeys.find((key) => this.failMoves.has(key));
    if (bad) throw new Error(`Issue ${bad} cannot be moved`);
  }
  async moveToBacklog(issueKeys: readonly string[]) {
    this.refuse(issueKeys);
    for (const key of issueKeys) {
      this.writes.push(`backlog:${key}`);
      const issue = this.issues.get(key);
      if (issue) issue.inSprint = false;
      this.sprintOf.set(key, null);
    }
  }
  origins: Array<{ id: number; requestId: string; issueKey: string; fromSprintId: string | null; toSprintId?: string | null }> = [];
  sprintStates: Record<string, 'active' | 'future' | 'closed'> = { '411': 'active', '412': 'future', '400': 'closed' };
  async moveToSprint(sprintId: string, issueKeys: readonly string[]) {
    this.refuse(issueKeys);
    for (const key of issueKeys) {
      this.writes.push(`sprint:${sprintId}:${key}`);
      this.sprintOf.set(key, sprintId);
    }
  }
  async shiftOrigins(requestIds: readonly string[]) {
    const orphan = (requestId: string) => !this.requests.some((r) => r.id === requestId);
    return this.origins
      .filter((o) => requestIds.includes(o.requestId) || orphan(o.requestId))
      .map(({ id, issueKey, fromSprintId, toSprintId }) => ({ id, issueKey, fromSprintId, toSprintId }));
  }
  async sprintState(sprintId: string) {
    return this.sprintStates[sprintId] ?? null;
  }
  async issuesInSprint(sprintId: string) {
    return new Set([...this.sprintOf].filter(([, sprint]) => sprint === sprintId).map(([key]) => key));
  }
  async inOpenSprints(issueKeys: readonly string[]) {
    return new Set(issueKeys.filter((key) => this.sprintOf.get(key)));
  }
  async sprintArchivedDeliverables() {
    return [...this.issues.entries()].filter(([, issue]) => issue.labels.includes(ARCHIVED_LABEL) && issue.inSprint).map(([key]) => key);
  }
  suggestionRows: Array<{ id: number; blockedIssueKey: string; blockerIssueKey: string; status: string }> = [];
  async linkSuggestions() {
    return this.suggestionRows.map(({ id, blockedIssueKey, blockerIssueKey }) => ({ id, blockedIssueKey, blockerIssueKey }));
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
  async deleteRows(scope: {
    requestIds: readonly string[];
    contractIds: readonly number[];
    shiftOriginIds: readonly number[];
    reopenSuggestionIds: readonly number[];
  }) {
    this.requests = this.requests.filter((r) => !scope.requestIds.includes(r.id));
    this.contracts = this.contracts.filter((c) => !scope.contractIds.includes(c.id));
    this.origins = this.origins.filter((o) => !scope.shiftOriginIds.includes(o.id));
    const before = this.suggestionRows.length;
    this.suggestionRows = this.suggestionRows
      .filter((s) => scope.reopenSuggestionIds.includes(s.id))
      .map((s) => ({ ...s, status: 'open' }));
    return { suggestions: before - this.suggestionRows.length };
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
    port.suggestionRows = [1, 2, 3].map((id) => ({ id, blockedIssueKey: `ACMOB-${id}`, blockerIssueKey: `ACPAY-${id}`, status: 'converted' }));
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
    expect(result.summary).toBe('Cleaned: 1 request, 1 contract, 1 link, 2 bugs reset, 3 comments removed, restored 0 moved issues');
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

    expect(again.summary).toBe('Cleaned: 0 requests, 0 contracts, 0 links, 0 bugs reset, 0 comments removed, restored 0 moved issues');
    expect(again.deliverablesArchived).toBe(0);
    expect(port.writes).toEqual([]);
  });

  it('puts shifted demo issues back to their earliest recorded sprint, skips closed sprints and foreign issues', async () => {
    port.origins = [
      { id: 1, requestId: 'r1', issueKey: 'ACPAY-4', fromSprintId: '411' },
      { id: 2, requestId: 'r1', issueKey: 'ACPAY-10', fromSprintId: '412' },
      { id: 3, requestId: 'r1', issueKey: 'ACPAY-7', fromSprintId: '400' },
      { id: 4, requestId: 'r1', issueKey: 'ACPAY-8', fromSprintId: null },
      { id: 5, requestId: 'r1', issueKey: 'PAY-3', fromSprintId: '411' },
      // A later shift of the same issue (from where the first one put it) never wins.
      { id: 6, requestId: 'r2', issueKey: 'ACPAY-4', fromSprintId: '412' },
      { id: 7, requestId: 'r-foreign', issueKey: 'ACPAY-9', fromSprintId: '411' },
    ];
    port.requests.push({ id: 'r2', requesterTeamId: 'team-mob', providerTeamId: 'team-pay' });
    for (const key of ['ACPAY-4', 'ACPAY-10', 'ACPAY-7', 'ACPAY-8', 'ACPAY-9']) port.issues.set(key, { labels: [], done: false, inSprint: false, demoBug: false });

    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.issuesRestored).toBe(3);
    expect(result.summary).toMatch(/, restored 3 moved issues$/);
    expect(port.writes).toEqual(expect.arrayContaining(['sprint:411:ACPAY-4', 'sprint:412:ACPAY-10', 'backlog:ACPAY-8']));
    expect(port.writes).not.toContain('sprint:412:ACPAY-4');
    expect(port.writes.some((w) => w.includes('ACPAY-7') || w.includes('ACPAY-9') || w.endsWith(':PAY-3'))).toBe(false);
    expect(result.notRestored[0]).toBe('ACPAY-7 stayed where it is: the sprint it came from is closed or no longer exists.');
    // Records of cleaned requests are gone: a second run restores nothing.
    port.writes = [];
    expect((await cleanDemoData(port, 'user-1', admin)).issuesRestored).toBe(0);
    expect(port.writes).toEqual([]);
  });

  describe('shifted issues that cannot simply go back', () => {
    const issue = (done = false) => ({ labels: [], done, inSprint: false, demoBug: false });

    beforeEach(() => {
      // Shift put all four in the backlog (toSprintId null); ACPAY-6 went to sprint 412.
      port.origins = [
        { id: 1, requestId: 'r1', issueKey: 'ACPAY-4', fromSprintId: '411', toSprintId: null },
        { id: 2, requestId: 'r1', issueKey: 'ACPAY-5', fromSprintId: '411', toSprintId: null },
        { id: 3, requestId: 'r1', issueKey: 'ACPAY-10', fromSprintId: '412', toSprintId: null },
        { id: 4, requestId: 'r1', issueKey: 'ACPAY-12', fromSprintId: '412', toSprintId: null },
        { id: 5, requestId: 'r1', issueKey: 'ACPAY-6', fromSprintId: '411', toSprintId: '412' },
      ];
      for (const key of ['ACPAY-4', 'ACPAY-5', 'ACPAY-10', 'ACPAY-12', 'ACPAY-6']) port.issues.set(key, issue());
      port.sprintOf.set('ACPAY-6', '412');
    });

    it('one issue Jira refuses or that was deleted does not stop the clean; its record stays for the retry', async () => {
      port.failMoves.add('ACPAY-5');
      port.issues.delete('ACPAY-12');

      const result = await cleanDemoData(port, 'user-1', admin);

      expect(result.issuesRestored).toBe(3);
      expect(port.sprintOf.get('ACPAY-4')).toBe('411');
      expect(port.sprintOf.get('ACPAY-10')).toBe('412');
      expect(port.sprintOf.get('ACPAY-6')).toBe('411');
      expect(result.summary).toMatch(/restored 3 moved issues, 1 could not be moved back \(ACPAY-5\)$/);
      expect(result.notRestored[0]).toBe('Could not move ACPAY-5 back; run Clean demo data again to retry.');
      // The request rows are still deleted; only the failed issue's record is kept, the deleted issue's is gone.
      expect(port.requests.map((r) => r.id)).toEqual(['r-foreign']);
      expect(port.origins.map((o) => o.issueKey)).toEqual(['ACPAY-5']);

      // Retry once Jira accepts the move: the orphaned record is found and settled.
      port.failMoves.clear();
      const again = await cleanDemoData(port, 'user-1', admin);
      expect(again.issuesRestored).toBe(1);
      expect(port.sprintOf.get('ACPAY-5')).toBe('411');
      expect(port.origins).toEqual([]);
    });

    it('skips Done issues and issues someone moved after the shift', async () => {
      port.issues.set('ACPAY-4', issue(true));
      port.sprintOf.set('ACPAY-5', '412'); // moved by hand from the backlog into Sprint 42
      port.sprintOf.set('ACPAY-6', null); // moved by hand from Sprint 42 to the backlog

      const result = await cleanDemoData(port, 'user-1', admin);

      expect(result.issuesRestored).toBe(2);
      expect(result.summary).toMatch(/restored 2 moved issues, skipped 3 \(ACPAY-4, ACPAY-5, ACPAY-6\)$/);
      expect(port.writes.some((w) => /ACPAY-(4|5|6)$/.test(w))).toBe(false);
      expect(result.notRestored).toEqual(
        expect.arrayContaining(['Skipped ACPAY-4: already Done.', 'Skipped ACPAY-5, ACPAY-6: moved by someone after the shift, so left where it is now.']),
      );
      expect(port.origins).toEqual([]);
    });
  });

  it('takes Accord deliverables out of their sprint before archiving them, also ones archived by an earlier clean', async () => {
    port.issues.set('ACPAY-25', { labels: ['accord', ARCHIVED_LABEL], done: true, inSprint: true, demoBug: false });
    port.issues.set('PAY-25', { labels: ['accord', ARCHIVED_LABEL], done: true, inSprint: true, demoBug: false });

    await cleanDemoData(port, 'user-1', admin);

    expect(port.writes.indexOf('backlog:ACPAY-18')).toBeLessThan(port.writes.indexOf('archive:ACPAY-18'));
    expect(port.writes.indexOf('backlog:ACPAY-18')).toBeGreaterThanOrEqual(0);
    expect(port.issues.get('ACPAY-18')?.inSprint).toBe(false);
    expect(port.issues.get('ACPAY-25')?.inSprint).toBe(false);
    expect(port.issues.get('PAY-25')?.inSprint).toBe(true);
  });

  it('shows a suggestion again when its blocks link still exists and deletes the others', async () => {
    port.links.set('L7', { blocker: 'ACPAY-3', blocked: 'ACMOB-1' });
    port.suggestionRows = [
      { id: 7, blockedIssueKey: 'ACMOB-1', blockerIssueKey: 'ACPAY-3', status: 'converted' },
      { id: 8, blockedIssueKey: 'ACMOB-2', blockerIssueKey: 'ACPAY-2', status: 'dismissed' },
    ];

    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.suggestionsReopened).toBe(1);
    expect(result.suggestions).toBe(1);
    expect(port.suggestionRows).toEqual([{ id: 7, blockedIssueKey: 'ACMOB-1', blockerIssueKey: 'ACPAY-3', status: 'open' }]);
    expect(port.links.has('L7')).toBe(true);
  });

  it('skips deliverables Accord did not create', async () => {
    port.deliverableAudit.clear();
    port.issues.set('ACPAY-18', { labels: [], done: false, inSprint: true, demoBug: false });

    const result = await cleanDemoData(port, 'user-1', admin);

    expect(result.deliverablesArchived).toBe(0);
    expect(port.writes).not.toContain('archive:ACPAY-18');
  });
});
