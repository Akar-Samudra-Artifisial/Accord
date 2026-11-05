import { InvocationError, InvocationErrorCode, type AsyncEvent } from '@forge/events';
import { productionDeps } from './deps';
import { applyContract, escalateSafely, runRound1, runRound2, type RoundResult } from './orchestrator';
import type { NegotiationDeps, NegotiationEvent } from './types';

/**
 * Attempts before the request is marked `failed`: the first run plus the four retries Forge allows
 * for an async event (`retryContext.retryCount` 1..4, see the Async events API "Retries" docs).
 */
export const MAX_ATTEMPTS = 5;
const RETRY_BASE_SECONDS = 10;

/** Exponential backoff: 10, 20, 40, 80 s (covers the deliverable search grace period). */
export const retryAfterSeconds = (retryCount: number) => RETRY_BASE_SECONDS * 2 ** Math.min(retryCount, 3);

export type HandleResult = RoundResult | { status: 'retry'; detail: string };

export function parseNegotiationEvent(body: unknown): NegotiationEvent | null {
  if (!body || typeof body !== 'object') return null;
  const { type, requestId } = body as Record<string, unknown>;
  if (typeof requestId !== 'string' || !/^req-[0-9a-f-]{36}$/.test(requestId)) return null;
  if (type === 'round1' || type === 'round2' || type === 'apply-contract') return { type, requestId };
  return null;
}

export async function handleNegotiationEvent(
  deps: NegotiationDeps,
  event: NegotiationEvent,
  retryCount: number,
): Promise<HandleResult> {
  try {
    if (event.type === 'round1') return await runRound1(deps, event.requestId);
    if (event.type === 'round2') return await runRound2(deps, event.requestId);
    return await applyContract(deps, event.requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`accord-negotiation ${event.type} ${event.requestId} failed (attempt ${retryCount + 1})`, message);
    if (retryCount + 1 >= MAX_ATTEMPTS) {
      const from = event.type === 'apply-contract' ? (['approved'] as const) : (['negotiating'] as const);
      await deps.store.transition(event.requestId, from, 'failed');
      await deps.store.audit('request', event.requestId, `${event.type}-failed`, null, { error: message.slice(0, 1000) });
      // FR-15: no agreement is possible without help; escalate() only acts while the request is failed.
      await escalateSafely(deps, event.requestId, 'failed');
      return { status: 'skipped', detail: `gave up: ${message}` };
    }
    // Every step is idempotent, so the platform may simply run the job again.
    return { status: 'retry', detail: message };
  }
}

/** `accord-negotiation` queue consumer (@forge/events v2+ function consumer: the pushed body is `event.body`). */
export async function negotiationConsumerHandler(event: AsyncEvent): Promise<HandleResult | InvocationError | { status: 'ignored' }> {
  const parsed = parseNegotiationEvent(event.body);
  if (!parsed) {
    console.log('accord-negotiation ignoring event', event.jobId, JSON.stringify(event.body).slice(0, 200));
    return { status: 'ignored' };
  }
  const started = Date.now();
  const retryCount = event.retryContext?.retryCount ?? 0;
  const result = await handleNegotiationEvent(productionDeps, parsed, retryCount);
  console.log(
    `accord-negotiation ${parsed.type} ${parsed.requestId}: ${result.status} (${result.detail}) in ${Date.now() - started} ms`,
  );
  if (result.status === 'retry') {
    return new InvocationError({ retryAfter: retryAfterSeconds(retryCount), retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST });
  }
  return result;
}
