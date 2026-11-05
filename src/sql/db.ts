import { sql, type UpdateQueryResponse } from '@forge/sql';
import { runMigrations } from './migrations';

export interface SchemaGuardOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * @forge/sql MigrationExecutionError / MigrationCheckPointError are not exported;
 * both carry `migrationName`. They are raised when parallel invocations on a fresh
 * install run the same DDL at once. All migrations are idempotent, so retrying is safe.
 */
export function isMigrationError(error: unknown): error is Error & { migrationName: string; cause?: unknown } {
  return error instanceof Error && 'migrationName' in error;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One migration path per function instance: concurrent callers share a single promise.
 * Migration conflicts are retried with exponential backoff and jitter; on final failure the
 * memo is cleared so the next call tries again.
 */
export function createSchemaGuard(
  migrate: () => Promise<string[]>,
  { attempts = 4, baseDelayMs = 250, sleep = defaultSleep, random = Math.random }: SchemaGuardOptions = {},
): () => Promise<string[]> {
  let ready: Promise<string[]> | null = null;

  const attempt = async (): Promise<string[]> => {
    for (let i = 1; ; i++) {
      try {
        return await migrate();
      } catch (error: unknown) {
        if (!isMigrationError(error) || i >= attempts) throw error;
        console.error(
          `[ensureSchema] migration ${error.migrationName} failed (attempt ${i}/${attempts}), retrying:`,
          error.cause ?? error,
        );
        await sleep(Math.round(baseDelayMs * 2 ** (i - 1) * (1 + random())));
      }
    }
  };

  return () => {
    if (!ready) {
      ready = attempt().catch((error: unknown) => {
        ready = null;
        if (isMigrationError(error)) {
          console.error(`[ensureSchema] migration ${error.migrationName} failed:`, error.cause ?? error);
        }
        throw error;
      });
    }
    return ready;
  };
}

/** Runs pending migrations once per warm function instance (resolvers fall back to this). */
export const ensureSchema: () => Promise<string[]> = createSchemaGuard(runMigrations);

type Param = string | number | boolean | null;

export async function select<Row>(statement: string, params: readonly Param[] = []): Promise<Row[]> {
  await ensureSchema();
  const result = await sql.prepare<Row>(statement).bindParams(...params).execute();
  return result.rows as Row[];
}

export async function run(statement: string, params: readonly Param[] = []): Promise<UpdateQueryResponse> {
  await ensureSchema();
  const result = await sql.prepare<UpdateQueryResponse>(statement).bindParams(...params).execute();
  return result.rows;
}

/** Forge SQL may return JSON columns as strings or already-parsed values. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}
