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

import { auditFor, contractsForProvider, lastDemoClean, sqlStore } from '../../src/negotiation/store';
import { request } from './fakes';

describe('audit since the last demo clean (SQL)', () => {
  beforeEach(() => {
    db.select.mockClear();
  });

  it('finds the latest clean by time, not by id', async () => {
    await lastDemoClean();
    expect(db.select.mock.calls[0][0]).toMatch(/action = 'demo-cleaned' ORDER BY created_at DESC, id DESC LIMIT 1/);
  });

  it('cuts at the time of the clean entry instead of comparing ids, newest first', async () => {
    await auditFor(['req-1'], [4], 50, 30165);
    const [statement, params] = db.select.mock.calls[0];
    expect(statement).toMatch(/created_at >= \(SELECT s\.created_at FROM audit_log s WHERE s\.id = \?\)/);
    expect(statement).not.toMatch(/\bid > \?/);
    expect(statement).toMatch(/ORDER BY created_at DESC, id DESC LIMIT 50$/);
    expect(params).toEqual(['req-1', '4', 30165]);
  });
});

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
    expect(statement).toMatch(/created_by <> \?\s+AND created_at > CURRENT_TIMESTAMP - INTERVAL 1 HOUR\) < \?/);
    expect(params?.slice(-7)).toEqual(['MOB-7', 'team-PAY', 'negotiating', 'awaiting-approval', 'team-PAY', 'app', 20]);
  });

  it('reports exists when the id is already stored (parallel attempt), also on a primary key error', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 0 });
    db.select.mockResolvedValueOnce([{ id: 'x' }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('exists');
    db.run.mockRejectedValueOnce(new Error('Duplicate entry for key PRIMARY'));
    db.select.mockResolvedValueOnce([{ id: 'x' }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('exists');
    db.run.mockRejectedValueOnce(new Error('connection reset'));
    db.select.mockResolvedValueOnce([]);
    await expect(sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).rejects.toThrow('connection reset');
  });

  it('reports a duplicate when an open request exists', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 0 });
    db.select.mockResolvedValueOnce([]);
    db.select.mockResolvedValueOnce([{ n: 1 }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('duplicate');
  });

  it('reports the provider limit otherwise', async () => {
    db.run.mockResolvedValueOnce({ affectedRows: 0 });
    db.select.mockResolvedValueOnce([]);
    db.select.mockResolvedValueOnce([{ n: 0 }]);
    expect(await sqlStore.insertRequest(request(), { maxPerProviderPerHour: 20 })).toBe('provider-limit');
  });
});
