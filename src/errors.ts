import { randomUUID } from 'node:crypto';

/** Errors whose message is written for end users and is safe to show in the UI. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/**
 * Message for the client: user-facing errors as is, anything else as a generic
 * text with a correlation id. The full detail only goes to `forge logs`.
 */
export function clientError(operation: string, error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  const ref = randomUUID().slice(0, 8);
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const extra = error && typeof error === 'object' && 'detail' in error ? String((error as { detail: unknown }).detail).slice(0, 1000) : '';
  console.error(`[${operation}] ref ${ref}: ${detail}${extra ? ` | detail: ${extra}` : ''}`);
  return `Something went wrong (${operation}). Reference ${ref}; details are in the app logs.`;
}
