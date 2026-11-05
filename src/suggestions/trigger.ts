import { suggestFromLink, type IssueLinkEvent } from './link-suggestions';
import { productionSuggestionDeps } from './store';

/** `avi:jira:created:issuelink`: records a request suggestion (FR-16); never creates a request. */
export async function issueLinkCreatedHandler(event: IssueLinkEvent): Promise<void> {
  const link = `link ${event.id ?? '?'} (${event.issueLinkType?.name ?? 'unknown type'})`;
  try {
    const result = await suggestFromLink(productionSuggestionDeps, event);
    if (result.outcome === 'ignored') console.log(`[issuelink] ${link} ignored: ${result.reason}`);
    else console.log(`[issuelink] ${link}: suggestion ${result.suggestion?.id ?? '?'} ${result.outcome}`);
  } catch (error) {
    // Not rethrown: Jira does not redeliver product events, and a missed suggestion is not critical.
    console.error(`[issuelink] ${link} failed`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}
