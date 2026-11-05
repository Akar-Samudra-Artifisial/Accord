import { describe, expect, it } from 'vitest';
import {
  convertSuggestions,
  dismissSuggestion,
  suggestFromLink,
  SUGGESTION_UNAVAILABLE,
  SuggestionError,
  visibleSuggestions,
  type IssueLinkEvent,
  type LinkSuggestion,
  type LinkSuggestionDeps,
  type SuggestionStore,
  type SuggestionTeam,
} from '../../src/suggestions/link-suggestions';

interface AuditCall {
  entityId: string;
  action: string;
  actor: string | null;
}

function fakeStore(): SuggestionStore & { rows: LinkSuggestion[]; audits: AuditCall[] } {
  const rows: LinkSuggestion[] = [];
  const audits: AuditCall[] = [];
  return {
    rows,
    audits,
    async insert(suggestion) {
      if (rows.some((row) => row.blockedIssueKey === suggestion.blockedIssueKey && row.blockerIssueKey === suggestion.blockerIssueKey)) {
        return 'exists';
      }
      rows.push({ ...suggestion, id: rows.length + 1, status: 'open', requestId: null });
      return 'inserted';
    },
    async byPair(blocked, blocker) {
      return rows.find((row) => row.blockedIssueKey === blocked && row.blockerIssueKey === blocker) ?? null;
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async openFor(blocked) {
      return rows.filter((row) => row.blockedIssueKey === blocked && row.status === 'open');
    },
    async close(id, status, requestId) {
      const index = rows.findIndex((row) => row.id === id && row.status === 'open');
      if (index < 0) return false;
      rows[index] = { ...rows[index], status, requestId };
      return true;
    },
    async audit(_entityType, entityId, action, actor) {
      audits.push({ entityId, action, actor });
    },
  };
}

const TEAMS: Record<string, SuggestionTeam> = {
  MOB: { id: 't-mob', teamKey: 'MOB', name: 'Mobile' },
  PAY: { id: 't-pay', teamKey: 'PAY', name: 'Payments' },
};
const ISSUES: Record<string, string> = { '10': 'PAY-7', '20': 'MOB-3', '21': 'MOB-4', '30': 'OPS-1' };

function deps(store: SuggestionStore): LinkSuggestionDeps {
  return {
    store,
    issueKey: async (id) => ISSUES[id] ?? null,
    teamByProjectKey: async (key) => TEAMS[key] ?? null,
  };
}

// "PAY-7 blocks MOB-3": source = blocker, destination = blocked.
const event = (overrides: Partial<IssueLinkEvent> = {}): IssueLinkEvent => ({
  eventType: 'avi:jira:created:issuelink',
  selfGenerated: false,
  id: '5001',
  sourceIssueId: '10',
  destinationIssueId: '20',
  issueLinkType: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  ...overrides,
});

const all = async (keys: readonly string[]) => new Set(keys);
const allowed = async () => true;

describe('suggestFromLink (FR-16)', () => {
  it('stores an open suggestion on the blocked issue for two different Accord teams', async () => {
    const store = fakeStore();
    const result = await suggestFromLink(deps(store), event());
    expect(result.outcome).toBe('suggested');
    expect(store.rows).toEqual([
      { id: 1, blockedIssueKey: 'MOB-3', blockerIssueKey: 'PAY-7', requesterTeamId: 't-mob', providerTeamId: 't-pay', linkId: '5001', status: 'open', requestId: null },
    ]);
    expect(store.audits).toEqual([{ entityId: '1', action: 'suggestion-created', actor: null }]);
  });

  it('ignores self-generated links (created by Accord)', async () => {
    const store = fakeStore();
    expect(await suggestFromLink(deps(store), event({ selfGenerated: true }))).toEqual({ outcome: 'ignored', reason: 'self-generated' });
    expect(store.rows).toEqual([]);
  });

  it('ignores link types other than Blocks', async () => {
    const store = fakeStore();
    const relates = event({ issueLinkType: { name: 'Relates', inward: 'relates to', outward: 'relates to' } });
    expect(await suggestFromLink(deps(store), relates)).toEqual({ outcome: 'ignored', reason: 'not-blocks' });
    expect(store.rows).toEqual([]);
  });

  it('ignores links within one team and links to unregistered projects', async () => {
    const store = fakeStore();
    expect(await suggestFromLink(deps(store), event({ sourceIssueId: '21' }))).toEqual({ outcome: 'ignored', reason: 'same-team' });
    expect(await suggestFromLink(deps(store), event({ sourceIssueId: '30' }))).toEqual({ outcome: 'ignored', reason: 'not-accord-teams' });
    expect(await suggestFromLink(deps(store), event({ sourceIssueId: '99' }))).toEqual({ outcome: 'ignored', reason: 'issue-not-found' });
    expect(await suggestFromLink(deps(store), event({ sourceIssueId: undefined }))).toEqual({ outcome: 'ignored', reason: 'missing-data' });
    expect(store.rows).toEqual([]);
  });

  it('is idempotent per issue pair, also after a dismissal', async () => {
    const store = fakeStore();
    await suggestFromLink(deps(store), event());
    const again = await suggestFromLink(deps(store), event({ id: '5002' }));
    expect(again).toMatchObject({ outcome: 'exists', suggestion: { id: 1 } });
    await dismissSuggestion(store, 1, 'acc-mob', all, allowed);
    expect((await suggestFromLink(deps(store), event({ id: '5003' }))).outcome).toBe('exists');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe('dismissed');
    expect(store.audits.filter((entry) => entry.action === 'suggestion-created')).toHaveLength(1);
  });
});

describe('suggestion visibility, dismiss and convert (FR-16)', () => {
  it('shows a suggestion only when the user can browse both issues', async () => {
    const store = fakeStore();
    await suggestFromLink(deps(store), event());
    expect(await visibleSuggestions(store, 'MOB-3', all)).toHaveLength(1);
    expect(await visibleSuggestions(store, 'MOB-3', async () => new Set(['MOB-3']))).toEqual([]);
    expect(await visibleSuggestions(store, 'MOB-3', async () => new Set(['PAY-7']))).toEqual([]);
  });

  it('dismisses with an audit entry, and refuses users who cannot see both issues or a second dismissal', async () => {
    const store = fakeStore();
    await suggestFromLink(deps(store), event());
    await expect(dismissSuggestion(store, 1, 'acc-x', async () => new Set(['MOB-3']), allowed)).rejects.toBeInstanceOf(SuggestionError);
    await expect(dismissSuggestion(store, 1, undefined, all, allowed)).rejects.toBeInstanceOf(SuggestionError);
    expect(await dismissSuggestion(store, 1, 'acc-mob', all, allowed)).toMatchObject({ id: 1, status: 'dismissed' });
    expect(store.audits.at(-1)).toEqual({ entityId: '1', action: 'suggestion-dismissed', actor: 'acc-mob' });
    await expect(dismissSuggestion(store, 1, 'acc-mob', all, allowed)).rejects.toThrow('already handled');
    expect(await visibleSuggestions(store, 'MOB-3', all)).toEqual([]);
  });

  it('requires link or comment permission on the blocked issue, with one message for missing and forbidden', async () => {
    const store = fakeStore();
    await suggestFromLink(deps(store), event());
    const checked: string[] = [];
    const denied = async (key: string) => {
      checked.push(key);
      return false;
    };
    await expect(dismissSuggestion(store, 1, 'acc-viewer', all, denied)).rejects.toThrow(SUGGESTION_UNAVAILABLE);
    expect(checked).toEqual(['MOB-3']);
    await expect(dismissSuggestion(store, 99, 'acc-viewer', all, allowed)).rejects.toThrow(SUGGESTION_UNAVAILABLE);
    await expect(dismissSuggestion(store, 1, 'acc-x', async () => new Set(['MOB-3']), allowed)).rejects.toThrow(SUGGESTION_UNAVAILABLE);
    expect(store.rows[0].status).toBe('open');
  });

  it('converts only the chosen suggestion, or the one with the matching blocker issue', async () => {
    const store = fakeStore();
    await suggestFromLink(deps(store), event());
    // A second blocker of the same team on the same issue (PAY-8 blocks MOB-3).
    ISSUES['11'] = 'PAY-8';
    await suggestFromLink(deps(store), event({ id: '5009', sourceIssueId: '11' }));
    const req = (id: string, providerTeamId = 't-pay') => ({ id, sourceIssueKey: 'MOB-3', providerTeamId });
    expect(await convertSuggestions(store, req('req-0'), 'acc-mob', {})).toEqual([]);
    expect(await convertSuggestions(store, req('req-1', 't-other'), 'acc-mob', { suggestionId: 1 })).toEqual([]);
    expect(await convertSuggestions(store, req('req-2'), 'acc-mob', { suggestionId: 2 })).toEqual([2]);
    expect(store.rows.map((row) => row.status)).toEqual(['open', 'converted']);
    expect(store.audits.at(-1)).toEqual({ entityId: '2', action: 'suggestion-converted', actor: 'acc-mob' });
    expect(await convertSuggestions(store, req('req-3'), 'acc-mob', { blockerIssueKey: 'PAY-9' })).toEqual([]);
    expect(await convertSuggestions(store, req('req-4'), 'acc-mob', { blockerIssueKey: 'PAY-7' })).toEqual([1]);
    expect(store.rows[0]).toMatchObject({ status: 'converted', requestId: 'req-4' });
    delete ISSUES['11'];
  });
});
