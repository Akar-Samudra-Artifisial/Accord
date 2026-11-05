import { describe, expect, it } from 'vitest';
import { betweenDates, formatDate, formatDateRange, formatDateTime } from '../../src/format/dates';
import { renderTemplate } from '../../src/planner/explain';

describe('date formatter', () => {
  it('shows ISO calendar dates as "Nov 29, 2026" without a time zone shift', () => {
    expect(formatDate('2026-11-29')).toBe('Nov 29, 2026');
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate('2026-12-31T23:30:00Z')).toBe('Dec 31, 2026');
  });

  it('formats timestamps in UTC, including SQL timestamps', () => {
    expect(formatDateTime('2026-11-05 14:03:00')).toBe('Nov 5, 2026, 14:03 UTC');
    expect(formatDateTime('2026-11-05T14:03:00.000Z')).toBe('Nov 5, 2026, 14:03 UTC');
  });

  it('uses the fallback for empty values and returns unparseable values unchanged', () => {
    expect(formatDate(null, 'not checked yet')).toBe('not checked yet');
    expect(formatDate('')).toBe('');
    expect(formatDate('soon')).toBe('soon');
  });

  it('formats ranges and collapses equal ends', () => {
    expect(formatDateRange('2026-11-20', '2026-11-29')).toBe('Nov 20, 2026 – Nov 29, 2026');
    expect(formatDateRange('2026-11-29', '2026-11-29')).toBe('Nov 29, 2026');
    expect(formatDateRange('', '', 'No date offered')).toBe('No date offered');
  });

  it('renders ISO date trace values in planner text and leaves other values alone', () => {
    expect(renderTemplate('{size} issues by {neededBy} ({sprint})', { size: 4, neededBy: '2026-11-29', sprint: 'PAY Sprint 2' })).toBe(
      '4 issues by Nov 29, 2026 (PAY Sprint 2)',
    );
  });

  it('says "on X" for a same-day span and "between X and Y" otherwise', () => {
    expect(betweenDates('2026-11-29', '2026-11-29')).toBe('on Nov 29, 2026');
    expect(betweenDates('2026-11-20', '2026-11-29')).toBe('between Nov 20, 2026 and Nov 29, 2026');
    expect(renderTemplate('Delivery {dateMin..dateMax}.', { dateMin: '2026-11-29', dateMax: '2026-11-29' })).toBe('Delivery on Nov 29, 2026.');
    expect(renderTemplate('Delivery {dateMin..dateMax}.', { dateMin: '2026-11-20', dateMax: '2026-11-29' })).toBe(
      'Delivery between Nov 20, 2026 and Nov 29, 2026.',
    );
  });

  it('pluralizes counts in planner text', () => {
    expect(renderTemplate('{n|issue} in {s|sprint}', { n: 1, s: 2 })).toBe('1 issue in 2 sprints');
  });
});
