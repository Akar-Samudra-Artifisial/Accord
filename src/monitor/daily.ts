import { InvocationError, InvocationErrorCode, type AsyncEvent } from '@forge/events';
import { monitorDeps, parseMonitorEvent, scheduleMonitor } from './deps';
import { monitorProviderTeam, type MonitorTeamResult } from './monitor';
import { retryEscalations } from '../negotiation/orchestrator';
import { pendingEscalations } from '../negotiation/store';
import { productionDeps } from '../negotiation/deps';

/**
 * Daily contract monitor (scheduledTrigger `accord-daily-monitor`). Only fans out:
 * each provider team is evaluated by its own `accord-monitor` queue job (NFR-5).
 */
export async function dailyMonitorHandler(): Promise<{ statusCode: number }> {
  const teams = await scheduleMonitor('schedule', null);
  console.log(`accord-monitor scheduled ${teams.length} provider team(s)`);
  // FR-15: escalation comments that failed earlier are posted now (idempotent per request).
  try {
    const retried = await retryEscalations(productionDeps, await pendingEscalations());
    if (retried.length) console.log(`accord-monitor retried ${retried.length} escalation(s): ${retried.map((r) => `${r.requestId} ${r.status}`).join(', ')}`);
  } catch (error) {
    console.error('accord-monitor escalation retry failed', error instanceof Error ? error.message : String(error));
  }
  return { statusCode: 204 };
}

const MAX_ATTEMPTS = 3;

/** `accord-monitor` queue consumer (@forge/events v2+ function consumer: the pushed body is `event.body`). */
export async function monitorConsumerHandler(
  event: AsyncEvent,
): Promise<MonitorTeamResult | InvocationError | { status: 'ignored' | 'failed' }> {
  const parsed = parseMonitorEvent(event.body);
  if (!parsed) {
    console.log('accord-monitor ignoring event', event.jobId, JSON.stringify(event.body).slice(0, 200));
    return { status: 'ignored' };
  }
  const retryCount = event.retryContext?.retryCount ?? 0;
  try {
    const result = await monitorProviderTeam(monitorDeps, parsed.teamId);
    console.log(
      `accord-monitor ${parsed.teamId}: ${result.evaluated.map((e) => `contract ${e.contractId} ${e.from}->${e.to}`).join(', ') || 'no contracts'}`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`accord-monitor ${parsed.teamId} failed (attempt ${retryCount + 1})`, message);
    if (retryCount + 1 >= MAX_ATTEMPTS) {
      await monitorDeps.store.audit('monitor', parsed.teamId, 'monitor-failed', null, { error: message.slice(0, 1000) });
      return { status: 'failed' };
    }
    // Evaluation is idempotent (conditional status update, comment markers), so a retry is safe.
    return new InvocationError({ retryAfter: 30, retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST });
  }
}
