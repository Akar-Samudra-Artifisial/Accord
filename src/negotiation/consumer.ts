import type { AsyncEvent } from '@forge/events';

/** Payload pushed to the `accord-negotiation` queue, one job per round (NFR-5). */
export interface NegotiationRoundEvent {
  requestId: string;
  roundNo: 1 | 2;
  role: 'provider-delegate' | 'requester-delegate' | 'broker';
}

/** `accord-negotiation` queue consumer (@forge/events v2+ function consumer: the pushed body is `event.body`). */
export async function negotiationConsumerHandler(event: AsyncEvent): Promise<{ status: string }> {
  // TODO(M2): run the round, store it in negotiation_rounds, enqueue the next one.
  console.log('accord-negotiation consumer received', event.jobId, JSON.stringify(event.body).slice(0, 200));
  return { status: 'not-implemented' };
}
