import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: (strings: TemplateStringsArray) => strings.join('') }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

import { defaultTitle, isPlaceholderTitle } from '../../src/resolvers/negotiation';

describe('defaultTitle', () => {
  it('keeps a given title, else uses the source issue summary, else a neutral fallback', () => {
    expect(defaultTitle('Refund API', 'Checkout refunds', 'ACMOB-1')).toBe('Refund API');
    expect(defaultTitle('', 'Checkout "refunds"\n flow', 'ACMOB-1')).toBe("Checkout 'refunds' flow");
    expect(defaultTitle('', undefined, 'ACMOB-1')).toBe('Work needed for ACMOB-1');
  });

  it('treats placeholder titles copied by an agent as empty', () => {
    for (const placeholder of ['(summary of the source issue)', '  (none) ', 'Summary of the source issue', '   ']) {
      expect(isPlaceholderTitle(placeholder)).toBe(true);
      expect(defaultTitle(placeholder, 'Checkout refunds', 'ACMOB-1')).toBe('Checkout refunds');
    }
    expect(isPlaceholderTitle('Refund API (v2)')).toBe(false);
    expect(defaultTitle('Refund API (v2)', 'Checkout refunds', 'ACMOB-1')).toBe('Refund API (v2)');
  });
});
