import { sql, type UpdateQueryResponse } from '@forge/sql';
import { runMigrations } from './migrations';

let schemaReady: Promise<string[]> | null = null;

/** Runs pending migrations once per warm function instance. */
export function ensureSchema(): Promise<string[]> {
  if (!schemaReady) {
    schemaReady = runMigrations().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

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
