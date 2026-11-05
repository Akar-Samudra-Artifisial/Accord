import { describe, expect, it } from 'vitest';
import {
  IDLE_WINDOW_MS,
  changedKey,
  contractIsMoving,
  contractSignature,
  idlePollingAllowed,
  keyedCallbacks,
  requestIsMoving,
} from '../../src/frontend/polling';

describe('stable button handlers in refreshing lists', () => {
  it('returns the same function per key on every render, so UI Kit keeps the handler id', () => {
    const opened: string[] = [];
    const open = keyedCallbacks((id: string) => opened.push(id));
    const first = open('req-1');
    expect(open('req-1')).toBe(first);
    expect(open('req-2')).not.toBe(first);
    first();
    open('req-2')();
    expect(opened).toEqual(['req-1', 'req-2']);
  });
});

describe('idle refresh of the global page', () => {
  it('runs for 10 minutes after the last interaction, then stops', () => {
    const at = 1_000_000;
    expect(idlePollingAllowed(at, at)).toBe(true);
    expect(idlePollingAllowed(at, at + IDLE_WINDOW_MS - 1)).toBe(true);
    expect(idlePollingAllowed(at, at + IDLE_WINDOW_MS)).toBe(false);
    expect(idlePollingAllowed(at, at - 1)).toBe(false);
  });

  it('only reports a change when the data differs, so the list does not re-render', () => {
    const items = [{ id: 'req-1', status: 'negotiating' }];
    const first = changedKey(null, items);
    expect(first).not.toBeNull();
    expect(changedKey(first, [{ id: 'req-1', status: 'negotiating' }])).toBeNull();
    // A new agent-created request, or its status moving on, is a change.
    expect(changedKey(first, [...items, { id: 'req-2', status: 'negotiating' }])).not.toBeNull();
    expect(changedKey(first, [{ id: 'req-1', status: 'awaiting-approval' }])).not.toBeNull();
  });
});

describe('polling predicates', () => {
  it('keeps polling while a request or contract is still settling in the background', () => {
    expect(requestIsMoving('negotiating')).toBe(true);
    expect(requestIsMoving('approved')).toBe(true);
    expect(requestIsMoving('contracted')).toBe(false);
    expect(contractIsMoving({ status: 'applying', projectedDate: null })).toBe(true);
    // "Not evaluated yet": the first monitor run has not stored a projected date.
    expect(contractIsMoving({ status: 'on-track', projectedDate: null })).toBe(true);
    expect(contractIsMoving({ status: 'on-track', projectedDate: '2026-11-29' })).toBe(false);
    expect(contractIsMoving({ status: 'at-risk', projectedDate: null })).toBe(false);
    expect(contractIsMoving(null)).toBe(false);
  });

  it('changes the signature when a status or projected date changes', () => {
    const before = contractSignature([{ contractId: 1, status: 'on-track', projectedDate: '2026-11-29' }]);
    expect(contractSignature([{ contractId: 1, status: 'at-risk', projectedDate: '2026-12-13' }])).not.toBe(before);
  });
});
