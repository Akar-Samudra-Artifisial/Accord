import { describe, expect, it } from 'vitest';
import { buildCharterStorage, charterBylineState } from '../../src/confluence/charter';

const storage = buildCharterStorage({
  teamName: 'Mobile',
  priorities: ['App store release'],
  redLines: [{ field: 'label', value: 'security' }],
  shiftable: [{ field: 'priority', value: 'Low' }],
  maxExternalShare: 0.2,
  responseDays: 2,
  approverAccountIds: ['557058:lead-1'],
  escalationAccountId: '557058:manager-1',
});

describe('charterBylineState (no SQL, page only)', () => {
  it('reports a valid charter and the team name from the page title', () => {
    expect(charterBylineState('Mobile team charter', storage)).toEqual({
      isCharter: true,
      teamName: 'Mobile',
      valid: true,
      missing: [],
    });
  });

  it('lists missing fields of an incomplete charter', () => {
    const state = charterBylineState('Mobile team charter', '<h2>Red lines</h2><p>Label: security</p>');
    expect(state.isCharter).toBe(true);
    expect(state.valid).toBe(false);
    expect(state.missing.length).toBeGreaterThan(0);
  });

  it('marks ordinary pages as not a charter', () => {
    expect(charterBylineState('Meeting notes', '<p>Hello</p>')).toMatchObject({ isCharter: false, teamName: null });
  });
});
