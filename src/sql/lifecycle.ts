import { ensureSchema } from './db';

interface LifecycleEvent {
  eventType?: string;
}

/**
 * avi:forge:installed:app / avi:forge:upgraded:app: migrate once right after install
 * (upgrades only fire for major versions), before the first page load fans out
 * parallel resolvers. Resolvers still call ensureSchema() as a fallback.
 */
export async function lifecycleHandler(event: LifecycleEvent): Promise<void> {
  try {
    const applied = await ensureSchema();
    console.log(`[lifecycle] ${event.eventType ?? 'event'}: ${applied.length} migration(s) applied`);
  } catch (error: unknown) {
    // Do not rethrow: a failed lifecycle run is retried lazily by the next resolver call.
    console.error(`[lifecycle] ${event.eventType ?? 'event'}: migrations failed`, error);
  }
}
