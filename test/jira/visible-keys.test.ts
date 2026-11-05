import { describe, expect, it, vi } from 'vitest';

const searches = vi.hoisted(() => [] as string[][]);

vi.mock('@forge/api', () => ({ default: {}, route: (strings: TemplateStringsArray) => strings.join('') }));
vi.mock('../../src/atlassian/http', async () => ({
  ...(await vi.importActual<typeof import('../../src/atlassian/http')>('../../src/atlassian/http')),
  // Every key exists and is browsable except the ACPAY ones.
  jira: vi.fn(async (_path: string, options: { body: { jql: string } }) => {
    const keys = /^key in \((.*)\)$/.exec(options.body.jql)![1].split(',');
    searches.push(keys);
    return { issues: keys.filter((key) => !key.startsWith('ACPAY-')).map((key) => ({ key, fields: {} })), isLast: true };
  }),
}));

import { VISIBLE_KEYS_BATCH, visibleIssueKeys } from '../../src/jira/issues';

describe('visibleIssueKeys', () => {
  it('deduplicates and checks at most 100 keys per JQL query', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `ACMOB-${i + 1}`);
    const visible = await visibleIssueKeys([...keys, ...keys.slice(0, 50), 'ACPAY-33', 'not a key'], 'user');
    expect(VISIBLE_KEYS_BATCH).toBe(100);
    expect(searches.map((batch) => batch.length)).toEqual([100, 100, 51]);
    expect(new Set(searches.flat()).size).toBe(251);
    expect(visible.size).toBe(250);
    expect(visible.has('ACPAY-33')).toBe(false);
  });

  it('makes no Jira call without valid keys', async () => {
    searches.length = 0;
    expect(await visibleIssueKeys(['bad'], 'user')).toEqual(new Set());
    expect(searches).toEqual([]);
  });
});
