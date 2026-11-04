import type { AsyncEvent } from '@forge/events';
import { SEED_STEPS, type SeedStep } from './seed-data';
import { handleSeedEvent, type SeedEvent } from './seed';
import { audit } from '../teams/repository';

function isSeedStep(value: unknown): value is SeedStep {
  return typeof value === 'string' && (SEED_STEPS as readonly string[]).includes(value);
}

/** `accord-demo-seed` queue consumer (@forge/events v2+ function consumer: the pushed body is `event.body`). */
export async function demoSeedConsumerHandler(event: AsyncEvent): Promise<void> {
  const payload = event.body;
  if (payload.kind === 'ping') {
    // Queue spike (M0): proves push → consumer → Forge SQL works end to end.
    console.log('accord-demo-seed consumer received ping', event.jobId);
    await audit('diag', 'queue', 'queue-ping', null, { sentAt: payload.sentAt, receivedAt: new Date().toISOString() });
    return;
  }
  if (payload.kind !== 'seed-step' || !isSeedStep(payload.step)) {
    console.error('Ignoring unknown demo queue event', JSON.stringify(payload).slice(0, 300));
    return;
  }
  await handleSeedEvent(payload as unknown as SeedEvent);
}
