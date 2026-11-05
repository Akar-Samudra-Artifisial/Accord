import { describe, expect, it } from 'vitest';
import { contractDirection, contractDisplay, neededByDates, optionDates, sprintDates } from '../../src/actions/display';

describe('contractDirection (viewer point of view)', () => {
  // Mobile asks, Payments delivers.
  const row = { requester: 'Mobile', requesterTeamKey: 'ACMOB', provider: 'Payments', providerTeamKey: 'ACPAY' };

  it('a Mobile viewer is owed the work, a Payments viewer owes it', () => {
    expect(contractDirection(row, new Set(['ACMOB']))).toEqual({
      viewerRole: 'requester',
      direction: 'owed-to-you',
      counterpartTeam: 'Payments',
      directionDisplay: 'Payments owes this to your team Mobile',
    });
    expect(contractDirection(row, new Set(['ACPAY']))).toEqual({
      viewerRole: 'provider',
      direction: 'you-owe',
      counterpartTeam: 'Mobile',
      directionDisplay: 'Your team Payments owes this to Mobile',
    });
  });

  it('a lead of both teams gets "both" and a ready sentence, every time', () => {
    const both = new Set(['ACMOB', 'ACPAY']);
    const expected = { viewerRole: 'both', direction: 'both', counterpartTeam: 'Mobile', directionDisplay: 'Payments delivers to Mobile' };
    expect(contractDirection(row, both)).toEqual(expected);
    expect(contractDirection(row, new Set(['ACPAY', 'ACMOB', 'ACWEB']))).toEqual(expected);
  });

  it('a viewer on neither team gets "none" and the same neutral sentence, never "you owe"', () => {
    expect(contractDirection(row, new Set(['ACWEB']))).toEqual({
      viewerRole: null,
      direction: 'none',
      counterpartTeam: null,
      directionDisplay: 'Payments delivers to Mobile',
    });
    expect(contractDirection(row, new Set())).toMatchObject({ direction: 'none' });
  });

  it('never returns "unknown"', () => {
    const sets = [new Set<string>(), new Set(['ACMOB']), new Set(['ACPAY']), new Set(['ACMOB', 'ACPAY']), new Set(['ACWEB'])];
    const rows = [row, { ...row, requesterTeamKey: null }, { ...row, providerTeamKey: null }];
    for (const r of rows) for (const own of sets) expect(JSON.stringify(contractDirection(r, own))).not.toMatch(/unknown/);
  });
});

describe('Rovo action display fields', () => {
  it('replaces raw contract dates and status codes with *Iso, statusCode and readable *Display fields', () => {
    const shown = contractDisplay({
      contractId: 7,
      agreedDateMin: '2026-11-29',
      agreedDateMax: '2026-11-29',
      projectedDate: '2026-11-27',
      status: 'on-track' as const,
    });
    expect(shown).toEqual({
      contractId: 7,
      agreedDateMinIso: '2026-11-29',
      agreedDateMaxIso: '2026-11-29',
      agreedDisplay: 'on Nov 29, 2026',
      projectedDateIso: '2026-11-27',
      projectedDisplay: 'Nov 27, 2026',
      statusCode: 'on-track',
      statusDisplay: 'On track',
    });
    expect(shown).not.toHaveProperty('status');
    expect(shown).not.toHaveProperty('agreedDateMin');
  });

  it('labels every contract status and explains a missing projection', () => {
    const base = { agreedDateMin: '2026-11-20', agreedDateMax: '2026-11-29', projectedDate: null };
    expect(contractDisplay({ ...base, status: 'at-risk' as const })).toMatchObject({
      agreedDisplay: 'between Nov 20, 2026 and Nov 29, 2026',
      statusDisplay: 'At risk',
      projectedDisplay: 'Beyond planning horizon',
    });
    expect(contractDisplay({ ...base, status: 'unknown' as const })).toMatchObject({ statusDisplay: 'Not enough data', projectedDisplay: 'Not enough data' });
    expect(contractDisplay({ ...base, status: 'applying' as const })).toMatchObject({ statusDisplay: 'Updating Jira', projectedDisplay: 'Not evaluated yet' });
  });

  it('formats option ranges, need dates and sprint dates', () => {
    expect(optionDates({ min: '2026-11-29', max: '2026-11-29' })).toEqual({
      dateRangeIso: { min: '2026-11-29', max: '2026-11-29' },
      dateRangeDisplay: 'on Nov 29, 2026',
    });
    expect(optionDates({ min: '', max: '' }).dateRangeDisplay).toBe('No date offered');
    expect(neededByDates('2026-11-29')).toEqual({ neededByIso: '2026-11-29', neededByDisplay: 'Nov 29, 2026' });
    expect(sprintDates('2026-11-02', '2026-11-15')).toEqual({
      startDateIso: '2026-11-02',
      startDateDisplay: 'Nov 2, 2026',
      endDateIso: '2026-11-15',
      endDateDisplay: 'Nov 15, 2026',
    });
  });
});
