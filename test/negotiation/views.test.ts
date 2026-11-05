import { describe, expect, it } from 'vitest';
import { appliedChanges, openSides, redactKeys, type OptionView, type SideStatus } from '../../src/negotiation/views';
import type { Contract } from '../../src/negotiation/types';

const none: SideStatus = { decision: null, optionId: null, optionLabel: null, byViewer: false };
const approved = (optionId: number): SideStatus => ({ decision: 'approve', optionId, optionLabel: 'On time', byViewer: true });

describe('openSides', () => {
  it('drops a side that already approved', () => {
    expect(openSides(['requester', 'provider'], { requester: approved(1), provider: none })).toEqual(['provider']);
  });

  it('reopens both sides when the teams approved different options', () => {
    expect(openSides(['requester', 'provider'], { requester: approved(1), provider: approved(2) })).toEqual([
      'requester',
      'provider',
    ]);
  });

  it('keeps undecided sides open', () => {
    expect(openSides(['provider'], { requester: none, provider: none })).toEqual(['provider']);
  });
});

describe('appliedChanges', () => {
  const option = {
    shifted: [
      { key: 'PAY-3', toSprint: 'PAY Sprint 2', toBacklog: false },
      { key: 'PAY-4', toSprint: 'Sprint +2', toBacklog: true },
    ],
  } as OptionView;
  const contract: Contract = {
    id: 1,
    requestId: 'req-1',
    optionId: 7,
    deliverableIssueKey: 'PAY-9',
    agreedDateMin: '2026-11-20',
    agreedDateMax: '2026-11-27',
    status: 'on-track',
    projectedDate: null,
  };

  it('lists created issue, link, moves and comments in past tense with linkable keys', () => {
    const changes = appliedChanges({ title: 'Refund API', sourceIssueKey: 'MOB-2' }, 'PAY', option, contract);
    expect(changes.map((c) => c.kind)).toEqual(['create-issue', 'link', 'move-sprint', 'move-backlog', 'comment']);
    expect(changes[0].text).toContain('Created PAY-9');
    expect(changes[1].issueKeys).toEqual(['PAY-9', 'MOB-2']);
    expect(changes[3].text).toBe('Moved PAY-4 to the backlog.');
  });

  it('says "Linked existing" for a kept deliverable and does not claim a new link', () => {
    const changes = appliedChanges({ title: 'Refund API', sourceIssueKey: 'MOB-2' }, 'PAY', option, contract, {
      deliverableCreated: false,
      linkCreated: false,
    });
    expect(changes[0].text).toBe('Linked existing PAY-9 "Refund API" in PAY and moved its due date to Nov 27, 2026.');
    expect(changes[1].text).toBe('PAY-9 already blocked MOB-2; no new link.');
  });

  it('keeps the sentences grammatical when the deliverable is hidden from the viewer', () => {
    const kept = appliedChanges({ title: 'Refund API', sourceIssueKey: 'MOB-2' }, 'PAY', option, contract, {
      deliverableCreated: false,
      linkCreated: false,
    }, new Set(['MOB-2']));
    expect(kept.map((c) => c.text)).toEqual([
      'Linked the existing deliverable (restricted) "Refund API" in PAY and moved its due date to Nov 27, 2026.',
      'A restricted issue already blocked MOB-2; no new link.',
      'Moved PAY-3 to PAY Sprint 2.',
      'Moved PAY-4 to the backlog.',
      'Commented on MOB-2 and a restricted issue with the agreed dates Nov 20, 2026 – Nov 27, 2026.',
    ]);
    expect(kept.flatMap((c) => c.issueKeys)).not.toContain('PAY-9');
  });

  it('redactKeys picks a label that fits the sentence', () => {
    expect(redactKeys('Keep the existing PAY-9 and move its due date.', ['PAY-9'])).toBe('Keep the existing deliverable (restricted) and move its due date.');
    expect(redactKeys('Renegotiation: contract PAY-9 → MOB-2 at risk', ['PAY-9'])).toBe('Renegotiation: contract for a restricted issue → MOB-2 at risk');
    expect(redactKeys('Renegotiation of the contract for PAY-9: agreed.', ['PAY-9'])).toBe('Renegotiation of the contract for a restricted issue: agreed.');
    expect(redactKeys('Done. PAY-9 moved; PAY-90 and XPAY-9 stay.', ['PAY-9'])).toBe('Done. A restricted issue moved; PAY-90 and XPAY-9 stay.');
    expect(redactKeys('Move PAY-9 to the backlog.', ['PAY-9'])).toBe('Move a restricted issue to the backlog.');
    // A link is dropped whole, never left as "/browse/a restricted issue".
    expect(redactKeys('See https://x.atlassian.net/browse/PAY-9?focused=1 and /browse/PAY-9.', ['PAY-9'])).toBe(
      'See a restricted issue and a restricted issue.',
    );
    expect(redactKeys('See https://x.atlassian.net/browse/PAY-90', ['PAY-9'])).toBe('See https://x.atlassian.net/browse/PAY-90');
  });

  it('is empty before the deliverable exists', () => {
    expect(appliedChanges({ title: 'x', sourceIssueKey: 'MOB-2' }, 'PAY', option, { ...contract, deliverableIssueKey: null })).toEqual([]);
  });
});
