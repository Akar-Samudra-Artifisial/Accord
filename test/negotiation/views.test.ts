import { describe, expect, it } from 'vitest';
import { appliedChanges, openSides, type OptionView, type SideStatus } from '../../src/negotiation/views';
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

  it('is empty before the deliverable exists', () => {
    expect(appliedChanges({ title: 'x', sourceIssueKey: 'MOB-2' }, 'PAY', option, { ...contract, deliverableIssueKey: null })).toEqual([]);
  });
});
