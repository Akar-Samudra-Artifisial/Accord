import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  select: vi.fn(async (_statement: string, _params?: readonly unknown[]): Promise<unknown[]> => []),
  run: vi.fn(async (_statement: string, _params?: readonly unknown[]) => ({ affectedRows: 1 })),
}));

vi.mock('../../src/sql/db', () => ({
  select: db.select,
  run: db.run,
  parseJson: <T>(value: unknown, fallback: T): T => (typeof value === 'string' ? (JSON.parse(value) as T) : ((value as T) ?? fallback)),
}));

import { contractsForProvider, sqlStore } from '../../src/negotiation/store';
import { request } from './fakes';

describe('contractsForProvider (SQL)', () => {
  beforeEach(() => {
    db.select.mockClear();
    db.run.mockClear();
  });

  it('filters by provider and status without a row limit', async () => {
    await contractsForProvider('team-PAY', ['on-track', 'at-risk', 'unknown']);
    const [statement, params] = db.select.mock.calls[0];
    expect(statement).toMatch(/WHERE r\.provider_team_id = \? AND c\.status IN \(\?, \?, \?\)/);
    expect(statement).not.toMatch(/LIMIT/i);
    expect(params).toEqual(['team-PAY', 'on-track', 'at-risk', 'unknown']);
  });

  it('runs no query for an empty status list', async () => {
    expect(await contractsForProvider('team-PAY', [])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('sqlStore.insertRequest (SQL)', () => {
  beforeEach(() => {
    db.select.mockReset();
    db.run.mockReset();
  });

  it('inserts with the duplicate and hourly checks in one statement', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 1 });
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('inserted');
    const [statement, params] = db.run.mock.calls[0];
    expect(statement).toMatch(/INSERT INTO requests[\s\S]*SELECT[\s\S]*WHERE NOT EXISTS/);
    expect(statement).toMatch(/INTERVAL 1 HOUR\) < \?/);
    expect(params?.slice(-6)).toEqual(['MOB-7', 'team-PAY', 'negotiating', 'awaiting-approval', 'team-PAY', 20]);
  });

  it('reports a duplicate when an open request exists', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 0 });
    db.select.mockResolvedValueOnce([{ n: 1 }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('duplicate');
  });

  it('reports the provider limit otherwise', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 0 });
    db.select.mockResolvedValueOnce([{ n: 0 }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('provider-limit');
  });
});
