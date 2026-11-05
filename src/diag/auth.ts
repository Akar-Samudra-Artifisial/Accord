import { createHash, timingSafeEqual } from 'node:crypto';

/** Header that must carry the development diag key (Forge variable ACCORD_DIAG_KEY). */
export const DIAG_KEY_HEADER = 'x-accord-diag-key';

/** Keys shorter than this are treated as unset, so a weak value never opens the trigger. */
const MIN_KEY_LENGTH = 32;

function headerValue(headers: Record<string, string[] | undefined> | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return values?.[0] ?? null;
  }
  return null;
}

/**
 * The diag web trigger URL is public: it answers only when ACCORD_DIAG_ENABLED is `true` AND the request
 * carries the key from ACCORD_DIAG_KEY. Both sides are hashed first, so the comparison is timing-safe and
 * does not leak the key length.
 */
export function diagAuthorized(
  headers: Record<string, string[] | undefined> | undefined,
  env: { ACCORD_DIAG_ENABLED?: string; ACCORD_DIAG_KEY?: string },
): boolean {
  if (env.ACCORD_DIAG_ENABLED !== 'true') return false;
  const expected = env.ACCORD_DIAG_KEY ?? '';
  if (expected.length < MIN_KEY_LENGTH) return false;
  const given = headerValue(headers, DIAG_KEY_HEADER);
  if (!given) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}
