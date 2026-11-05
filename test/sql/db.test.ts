import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/sql', () => ({
  sql: { prepare: vi.fn() },
  migrationRunner: { enqueue: vi.fn(), run: vi.fn() },
}));

import { createSchemaGuard } from '../../src/sql/db';
import { MIGRATIONS } from '../../src/sql/migrations';

class FakeMigrationError extends Error {
  constructor(
    readonly migrationName: string,
    readonly cause: unknown = new Error('conflict'),
  ) {
    super(`Failed to execute migration with name ${migrationName}`);
    this.name = 'ForgeSQLError';
  }
}

const noSleep = vi.fn(async (_ms: number) => undefined);

describe('createSchemaGuard', () => {
  it('runs migrations once for concurrent and later callers', async () => {
    const migrate = vi.fn(async () => ['v001']);
    const ensure = createSchemaGuard(migrate, { sleep: noSleep });
    const results = await Promise.all([ensure(), ensure(), ensure(), ensure(), ensure()]);
    await ensure();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r[0] === 'v001')).toBe(true);
  });

  it('retries a migration conflict with growing backoff and then succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const migrate = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new FakeMigrationError('v008_create_contracts'))
      .mockRejectedValueOnce(new FakeMigrationError('v010_create_audit_log'))
      .mockResolvedValueOnce(['v010_create_audit_log']);
    const ensure = createSchemaGuard(migrate, { sleep, baseDelayMs: 100, random: () => 0 });
    const [a, b] = await Promise.all([ensure(), ensure()]);
    expect(a).toEqual(['v010_create_audit_log']);
    expect(b).toBe(a);
    expect(migrate).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it('gives up after the attempt limit and clears the memo for the next call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const migrate = vi.fn<() => Promise<string[]>>().mockRejectedValue(new FakeMigrationError('v009_create_dependency_edges'));
    const ensure = createSchemaGuard(migrate, { attempts: 3, sleep: noSleep });
    await expect(ensure()).rejects.toThrow('v009_create_dependency_edges');
    expect(migrate).toHaveBeenCalledTimes(3);

    migrate.mockResolvedValueOnce([]);
    await expect(ensure()).resolves.toEqual([]);
    expect(migrate).toHaveBeenCalledTimes(4);
  });

  it('does not retry errors that are not migration failures', async () => {
    const migrate = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error('network down'));
    const ensure = createSchemaGuard(migrate, { sleep: noSleep });
    await expect(ensure()).rejects.toThrow('network down');
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});

describe('MIGRATIONS', () => {
  it('are all idempotent so a concurrent or repeated run is safe', () => {
    for (const { name, statement } of MIGRATIONS) {
      const s = statement.trim();
      expect(s, name).not.toMatch(/^\s*ALTER\b/i);
      expect(s, name).toMatch(/^(CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS|INSERT IGNORE)\b/i);
    }
  });

  it('have unique names', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
