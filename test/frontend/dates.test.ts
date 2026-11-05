import { describe, expect, it } from 'vitest';
import { defaultNeededBy } from '../../src/frontend/dates';

describe('defaultNeededBy', () => {
  it('is today (UTC) plus 21 days', () => {
    expect(defaultNeededBy(new Date('2026-11-05T01:30:00Z'))).toBe('2026-11-26');
  });

  it('uses the UTC calendar date near midnight and crosses month/year ends', () => {
    expect(defaultNeededBy(new Date('2026-12-20T23:59:59Z'))).toBe('2027-01-10');
    expect(defaultNeededBy(new Date('2026-02-10T00:00:00Z'), 21)).toBe('2026-03-03');
  });

  it('is always in the future', () => {
    const now = new Date();
    expect(defaultNeededBy(now) > now.toISOString().slice(0, 10)).toBe(true);
  });
});
