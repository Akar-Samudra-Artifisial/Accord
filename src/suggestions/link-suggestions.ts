/**
 * Request suggestions from Jira "blocks" links (FR-16). A link between issues of two different Accord
 * teams becomes an `open` suggestion on the blocked (requesting) issue. Accord never creates a request
 * on its own (US-3): a user converts the suggestion from the issue panel, or dismisses it.
 */
import { UserFacingError } from '../errors';

export type SuggestionStatus = 'open' | 'dismissed' | 'converted';

export interface LinkSuggestion {
  id: number;
  /** Issue that "is blocked by" the blocker; belongs to the requesting team. */
  blockedIssueKey: string;
  /** Issue that "blocks"; belongs to the providing team. */
  blockerIssueKey: string;
  requesterTeamId: string;
  providerTeamId: string;
  linkId: string | null;
  status: SuggestionStatus;
  requestId: string | null;
}

export type NewLinkSuggestion = Omit<LinkSuggestion, 'id' | 'status' | 'requestId'>;

/** Payload of `avi:jira:created:issuelink` (Forge product event). */
export interface IssueLinkEvent {
  eventType?: string;
  selfGenerated?: boolean;
  id?: string;
  sourceIssueId?: string;
  destinationIssueId?: string;
  sourceProjectId?: string;
  destinationProjectId?: string;
  issueLinkType?: { id?: string; name?: string; inward?: string; outward?: string };
}

export interface SuggestionTeam {
  id: string;
  teamKey: string;
  name: string;
}

export interface SuggestionStore {
  /** Inserts unless the issue pair already has a suggestion (any status). */
  insert(suggestion: NewLinkSuggestion): Promise<'inserted' | 'exists'>;
  byPair(blockedIssueKey: string, blockerIssueKey: string): Promise<LinkSuggestion | null>;
  get(id: number): Promise<LinkSuggestion | null>;
  openFor(blockedIssueKey: string): Promise<LinkSuggestion[]>;
  /** Moves an `open` suggestion to `status`; false when it was no longer open. */
  close(id: number, status: Exclude<SuggestionStatus, 'open'>, requestId: string | null): Promise<boolean>;
  audit(entityType: string, entityId: string, action: string, actorAccountId: string | null, payload: unknown): Promise<void>;
}

export interface LinkSuggestionDeps {
  store: SuggestionStore;
  /** Key of a Jira issue by id (as the app), null when it does not exist. */
  issueKey(issueId: string): Promise<string | null>;
  teamByProjectKey(projectKey: string): Promise<SuggestionTeam | null>;
}

export type IgnoreReason = 'self-generated' | 'not-blocks' | 'missing-data' | 'issue-not-found' | 'not-accord-teams' | 'same-team';

export type LinkOutcome =
  | { outcome: 'ignored'; reason: IgnoreReason }
  | { outcome: 'suggested' | 'exists'; suggestion: LinkSuggestion | null };

export class SuggestionError extends UserFacingError {}

const ISSUE_ID = /^[1-9][0-9]{0,17}$/;

export function projectKeyOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf('-'));
}

/**
 * Handles a created issue link. Jira stores "A blocks B" with A as the link source and B as the
 * destination (see `linkBlocks` in src/jira/issues.ts), so the destination is the blocked issue.
 */
export async function suggestFromLink(deps: LinkSuggestionDeps, event: IssueLinkEvent): Promise<LinkOutcome> {
  // Links Accord creates itself (apply-contract) are already covered by a request.
  if (event.selfGenerated === true) return { outcome: 'ignored', reason: 'self-generated' };
  if (event.issueLinkType?.name !== 'Blocks') return { outcome: 'ignored', reason: 'not-blocks' };
  const blockerId = event.sourceIssueId ?? '';
  const blockedId = event.destinationIssueId ?? '';
  if (!ISSUE_ID.test(blockerId) || !ISSUE_ID.test(blockedId)) return { outcome: 'ignored', reason: 'missing-data' };
  const [blockerIssueKey, blockedIssueKey] = await Promise.all([deps.issueKey(blockerId), deps.issueKey(blockedId)]);
  if (!blockerIssueKey || !blockedIssueKey) return { outcome: 'ignored', reason: 'issue-not-found' };
  const [provider, requester] = await Promise.all([
    deps.teamByProjectKey(projectKeyOf(blockerIssueKey)),
    deps.teamByProjectKey(projectKeyOf(blockedIssueKey)),
  ]);
  if (!provider || !requester) return { outcome: 'ignored', reason: 'not-accord-teams' };
  if (provider.id === requester.id) return { outcome: 'ignored', reason: 'same-team' };
  const inserted = await deps.store.insert({
    blockedIssueKey,
    blockerIssueKey,
    requesterTeamId: requester.id,
    providerTeamId: provider.id,
    linkId: event.id && ISSUE_ID.test(event.id) ? event.id : null,
  });
  const suggestion = await deps.store.byPair(blockedIssueKey, blockerIssueKey);
  if (inserted === 'inserted' && suggestion) {
    await deps.store.audit('suggestion', String(suggestion.id), 'suggestion-created', null, {
      blockedIssueKey,
      blockerIssueKey,
      linkId: suggestion.linkId,
    });
  }
  return { outcome: inserted === 'inserted' ? 'suggested' : 'exists', suggestion };
}

/** Open suggestions of `issueKey` whose two issues the viewer can both browse (checked as the user). */
export async function visibleSuggestions(
  store: SuggestionStore,
  issueKey: string,
  visibleKeys: (keys: readonly string[]) => Promise<Set<string>>,
): Promise<LinkSuggestion[]> {
  const open = await store.openFor(issueKey);
  if (open.length === 0) return [];
  const visible = await visibleKeys([issueKey, ...open.map((suggestion) => suggestion.blockerIssueKey)]);
  if (!visible.has(issueKey)) return [];
  return open.filter((suggestion) => visible.has(suggestion.blockerIssueKey));
}

/** One message for a missing suggestion and one the user may not touch, so ids reveal nothing. */
export const SUGGESTION_UNAVAILABLE = 'This suggestion is not available. Refresh the panel.';

/**
 * Dismisses an open suggestion for a user who can browse both issues and may link issues or
 * comment on the blocked issue (`canDismiss`, checked as the user); audited.
 */
export async function dismissSuggestion(
  store: SuggestionStore,
  suggestionId: number,
  accountId: string | undefined,
  visibleKeys: (keys: readonly string[]) => Promise<Set<string>>,
  canDismiss: (blockedIssueKey: string) => Promise<boolean>,
): Promise<LinkSuggestion> {
  if (!accountId) throw new SuggestionError('A signed-in Jira user is required.');
  const suggestion = await store.get(suggestionId);
  if (!suggestion) throw new SuggestionError(SUGGESTION_UNAVAILABLE);
  const visible = await visibleKeys([suggestion.blockedIssueKey, suggestion.blockerIssueKey]);
  if (!visible.has(suggestion.blockedIssueKey) || !visible.has(suggestion.blockerIssueKey)) {
    throw new SuggestionError(SUGGESTION_UNAVAILABLE);
  }
  if (!(await canDismiss(suggestion.blockedIssueKey))) throw new SuggestionError(SUGGESTION_UNAVAILABLE);
  if (suggestion.status !== 'open' || !(await store.close(suggestion.id, 'dismissed', null))) {
    throw new SuggestionError('This suggestion was already handled. Refresh the panel.');
  }
  await store.audit('suggestion', String(suggestion.id), 'suggestion-dismissed', accountId, {
    blockedIssueKey: suggestion.blockedIssueKey,
    blockerIssueKey: suggestion.blockerIssueKey,
  });
  return { ...suggestion, status: 'dismissed' };
}

/** Which suggestion a new request answers: the card it was created from, or a named blocker issue. */
export interface ConvertTarget {
  suggestionId?: number;
  blockerIssueKey?: string;
}

/**
 * Marks the open suggestions answered by a new request as `converted`: only those of the request's source
 * issue and provider team that match `target` (the chosen card or its blocker issue). Without a target
 * nothing is closed, because one issue can be blocked by several issues of the same team.
 * Returns the converted suggestion ids.
 */
export async function convertSuggestions(
  store: SuggestionStore,
  request: { id: string; sourceIssueKey: string; providerTeamId: string },
  accountId: string | null,
  target: ConvertTarget,
): Promise<number[]> {
  if (target.suggestionId === undefined && !target.blockerIssueKey) return [];
  const converted: number[] = [];
  for (const suggestion of await store.openFor(request.sourceIssueKey)) {
    if (suggestion.providerTeamId !== request.providerTeamId) continue;
    if (target.suggestionId !== undefined && suggestion.id !== target.suggestionId) continue;
    if (target.blockerIssueKey && suggestion.blockerIssueKey !== target.blockerIssueKey) continue;
    if (!(await store.close(suggestion.id, 'converted', request.id))) continue;
    await store.audit('suggestion', String(suggestion.id), 'suggestion-converted', accountId, {
      requestId: request.id,
      blockerIssueKey: suggestion.blockerIssueKey,
    });
    converted.push(suggestion.id);
  }
  return converted;
}
