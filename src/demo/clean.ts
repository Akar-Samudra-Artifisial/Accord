import { UserFacingError } from '../errors';
import { plural } from '../format/text';

/** Label added to Accord-created deliverables when the demo data is cleaned (issues are never deleted). */
export const ARCHIVED_LABEL = 'accord-archived';
/** Label every deliverable Accord creates carries (`ensureDeliverable`). */
export const DELIVERABLE_LABEL = 'accord';

export interface CleanRequestRow {
  id: string;
  requesterTeamId: string;
  providerTeamId: string;
}

export interface CleanContractRow {
  id: number;
  requestId: string;
  deliverableIssueKey: string | null;
}

export interface CleanShiftOrigin {
  /** Insert order: the lowest id per issue is its earliest recorded position. */
  id: number;
  issueKey: string;
  fromSprintId: string | null;
  /** Where the shift put the issue (null = backlog); undefined when it was not recorded (older rows). */
  toSprintId?: string | null;
}

export interface CleanSuggestionRow {
  id: number;
  blockedIssueKey: string;
  blockerIssueKey: string;
}

/** Side effects of "Clean demo data", injected so the scope rules can be tested without Forge. */
export interface DemoCleanPort {
  /** Demo projects Accord created itself (`accord.demo` property / teams rule); never foreign projects. */
  accordProjects(): Promise<Array<{ projectKey: string; name: string }>>;
  /** Registered team id of a project, null when the project is no Accord team. */
  teamIdOf(projectKey: string): Promise<string | null>;
  /** Requests whose requester AND provider are both one of `teamIds`. */
  requestsBetween(teamIds: readonly string[]): Promise<CleanRequestRow[]>;
  contractsOf(requestIds: readonly string[]): Promise<CleanContractRow[]>;
  /** Issue keys of `deliverable-created` audit entries of these contracts. */
  recordedDeliverables(contractIds: readonly number[]): Promise<Set<string>>;
  /** Blocks links of `link-created` audit entries of these contracts. */
  recordedLinks(contractIds: readonly number[]): Promise<Array<{ blocker: string; blocked: string }>>;
  /** Open demo bugs (demo bug labels) of these projects that sit in an open sprint. */
  sprintDemoBugs(projectKeys: readonly string[]): Promise<string[]>;
  moveToBacklog(issueKeys: readonly string[]): Promise<void>;
  moveToSprint(sprintId: string, issueKeys: readonly string[]): Promise<void>;
  /**
   * Recorded positions of issues apply-contract shifted for these requests (`fromSprintId` null = backlog), plus
   * records whose request is gone (left by an earlier clean that could not move the issue back).
   */
  shiftOrigins(requestIds: readonly string[]): Promise<CleanShiftOrigin[]>;
  /** State of a sprint; null when it no longer exists. */
  sprintState(sprintId: string): Promise<'active' | 'future' | 'closed' | null>;
  /** Keys of the issues in a sprint. */
  issuesInSprint(sprintId: string): Promise<Set<string>>;
  /** Subset of `issueKeys` that sits in an active or future sprint. */
  inOpenSprints(issueKeys: readonly string[]): Promise<Set<string>>;
  /** Archived Accord deliverables of these projects that still sit in an active or future sprint. */
  sprintArchivedDeliverables(projectKeys: readonly string[]): Promise<string[]>;
  /** Link suggestions between these teams (any status). */
  linkSuggestions(teamIds: readonly string[]): Promise<CleanSuggestionRow[]>;
  /** Labels and Done state of an issue; null when it no longer exists. */
  issueState(issueKey: string): Promise<{ labels: string[]; done: boolean } | null>;
  /** Adds ARCHIVED_LABEL and moves the issue to Done (backlog when the workflow has no Done transition). */
  archiveDeliverable(issueKey: string, done: boolean): Promise<'done' | 'backlog'>;
  /** Ids of "blocker blocks blocked" links. */
  blocksLinkIds(blocker: string, blocked: string): Promise<string[]>;
  deleteLink(linkId: string): Promise<void>;
  /** Account id of the app itself (`/myself` as the app); null when it is not an app account. */
  appAccountId(): Promise<string | null>;
  /** Issue keys of every comment marker Accord recorded in audit_log (all takes, not only current requests). */
  commentedIssues(): Promise<string[]>;
  /** Comments of an issue with their author; empty when the issue no longer exists. */
  listComments(issueKey: string): Promise<Array<{ id: string; authorAccountId: string | null }>>;
  deleteComment(issueKey: string, commentId: string): Promise<void>;
  /**
   * Deletes the SQL rows of these requests/contracts, the shift records `shiftOriginIds` and the link suggestions
   * between `teamIds`, except `reopenSuggestionIds`, which become open again (no request).
   */
  deleteRows(scope: {
    requestIds: readonly string[];
    contractIds: readonly number[];
    teamIds: readonly string[];
    shiftOriginIds: readonly number[];
    reopenSuggestionIds: readonly number[];
  }): Promise<{ suggestions: number }>;
  audit(action: string, actor: string | null, payload: unknown): Promise<void>;
}

export interface DemoCleanResult {
  projects: string[];
  requests: number;
  contracts: number;
  links: number;
  bugsReset: number;
  /** Shifted issues moved back to the sprint (or backlog) they came from. */
  issuesRestored: number;
  commentsRemoved: number;
  deliverablesArchived: number;
  /** Link suggestions deleted (their link is gone). */
  suggestions: number;
  /** Link suggestions shown again because their "blocks" link still exists. */
  suggestionsReopened: number;
  summary: string;
  /** What the clean deliberately leaves as it is (shown with the result). */
  notRestored: string[];
}

export const NOT_RESTORED = [
  'Comments written by people stay; only comments posted by the Accord app are removed.',
  'Issues moved to make room for a contract go back to the sprint they came from, unless they are Done, were moved again by someone, or their sprint has been closed or deleted since.',
  'Due dates were only set on Accord deliverables, which are archived instead of restored.',
];

/** Comment deletions per run; Jira calls run PARALLEL at a time (resolvers have a short time limit). */
export const MAX_COMMENTS_PER_RUN = 120;
const PARALLEL = 10;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += PARALLEL) result.push(values.slice(i, i + PARALLEL));
  return result;
}

export interface RestoreOutcome {
  restored: number;
  /** Origin sprint closed or deleted. */
  kept: string[];
  /** Done, or moved by someone since the shift. */
  skipped: Array<{ issueKey: string; reason: 'done' | 'moved' }>;
  /** Jira refused the move; their records stay, so the next clean retries them. */
  failed: string[];
  /** Records that are settled (restored, skipped, kept, issue gone, not a demo issue) and can be deleted. */
  settledIds: number[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Moves `keys` as one batch; when Jira refuses the batch, one by one. Returns the keys that could not move. */
async function moveEach(keys: readonly string[], move: (keys: readonly string[]) => Promise<void>): Promise<string[]> {
  try {
    await move(keys);
    return [];
  } catch (error) {
    if (keys.length === 1) {
      console.error(`Accord demo clean: ${keys[0]} could not be moved back`, errorText(error));
      return [...keys];
    }
  }
  const failed: string[] = [];
  for (const key of keys) failed.push(...(await moveEach([key], move)));
  return failed;
}

/**
 * Puts every issue a contract shifted back where it was before the first shift (lowest record id per issue):
 * into its original sprint while that sprint exists and is not closed, or into the backlog. Only issues of
 * Accord's demo projects (`owned`) that still exist and are not Done; an issue that is no longer where the
 * last shift put it was moved by someone and is left alone. One failing issue never stops the others.
 */
async function restoreShifted(
  port: DemoCleanPort,
  requestIds: readonly string[],
  owned: (issueKey: string) => boolean,
): Promise<RestoreOutcome> {
  const origins = [...(await port.shiftOrigins(requestIds))].sort((a, b) => a.id - b.id);
  const earliest = new Map<string, CleanShiftOrigin>();
  const latest = new Map<string, CleanShiftOrigin>();
  for (const origin of origins.filter((item) => owned(item.issueKey))) {
    if (!earliest.has(origin.issueKey)) earliest.set(origin.issueKey, origin);
    latest.set(origin.issueKey, origin);
  }
  const outcome: RestoreOutcome = { restored: 0, kept: [], skipped: [], failed: [], settledIds: [] };

  // Candidates: issues that still exist and are not Done.
  const candidates: string[] = [];
  for (const issueKey of earliest.keys()) {
    try {
      const state = await port.issueState(issueKey);
      if (state?.done) outcome.skipped.push({ issueKey, reason: 'done' });
      else if (state) candidates.push(issueKey);
    } catch (error) {
      console.error(`Accord demo clean: state of ${issueKey} could not be read`, errorText(error));
      outcome.failed.push(issueKey);
    }
  }

  // Left alone: issues that are no longer where the last shift put them (someone moved them since).
  const sprintIssues = new Map<string, Set<string>>();
  const toBacklog = candidates.filter((key) => latest.get(key)?.toSprintId === null);
  let inOpen = new Set<string>();
  try {
    if (toBacklog.length) inOpen = await port.inOpenSprints(toBacklog);
    for (const key of candidates) {
      const target = latest.get(key)?.toSprintId;
      if (target && !sprintIssues.has(target)) sprintIssues.set(target, await port.issuesInSprint(target));
    }
  } catch (error) {
    console.error('Accord demo clean: current sprints of shifted issues could not be read', errorText(error));
    outcome.failed.push(...candidates);
    candidates.length = 0;
  }
  const bySprint = new Map<string | null, string[]>();
  for (const key of candidates) {
    const target = latest.get(key)?.toSprintId;
    const inPlace = target === undefined || (target === null ? !inOpen.has(key) : sprintIssues.get(target)?.has(key) === true);
    if (!inPlace) {
      outcome.skipped.push({ issueKey: key, reason: 'moved' });
      continue;
    }
    const from = earliest.get(key)!.fromSprintId;
    bySprint.set(from, [...(bySprint.get(from) ?? []), key]);
  }

  for (const [sprintId, keys] of bySprint) {
    if (sprintId !== null) {
      let state: Awaited<ReturnType<DemoCleanPort['sprintState']>>;
      try {
        state = await port.sprintState(sprintId);
      } catch (error) {
        console.error(`Accord demo clean: sprint ${sprintId} could not be read`, errorText(error));
        outcome.failed.push(...keys);
        continue;
      }
      if (state === null || state === 'closed') {
        outcome.kept.push(...keys);
        continue;
      }
    }
    const failed = await moveEach(keys, (batch) => (sprintId === null ? port.moveToBacklog(batch) : port.moveToSprint(sprintId, batch)));
    outcome.failed.push(...failed);
    outcome.restored += keys.length - failed.length;
  }

  const failed = new Set(outcome.failed);
  outcome.settledIds = origins.filter((origin) => !failed.has(origin.issueKey)).map((origin) => origin.id);
  return outcome;
}

/** Suggestions between demo teams whose "blocks" link still exists are shown again; the others are deleted. */
async function suggestionsToReopen(port: DemoCleanPort, teamIds: readonly string[], owned: (issueKey: string) => boolean): Promise<number[]> {
  if (teamIds.length === 0) return [];
  const reopen: number[] = [];
  for (const suggestion of await port.linkSuggestions(teamIds)) {
    if (!owned(suggestion.blockedIssueKey) || !owned(suggestion.blockerIssueKey)) continue;
    if ((await port.blocksLinkIds(suggestion.blockerIssueKey, suggestion.blockedIssueKey)).length > 0) reopen.push(suggestion.id);
  }
  return reopen;
}

/**
 * Resets the Accord demo for a new take: Accord-created Jira changes are undone where that is safe, then the
 * SQL rows of every request between two Accord demo teams are deleted. Only Accord's own demo projects are
 * touched (every issue key is checked against them before a write); issues are never deleted and audit_log is
 * kept (a `demo-cleaned` entry marks the reset). Idempotent: a second run finds nothing left and reports zeros.
 */
export async function cleanDemoData(
  port: DemoCleanPort,
  actor: string | null,
  canManage: (projectKey: string) => Promise<boolean>,
): Promise<DemoCleanResult> {
  const projects = await port.accordProjects();
  if (projects.length === 0) throw new UserFacingError('There are no Accord demo projects yet. Run "Seed demo data" first.');
  for (const project of projects) {
    if (!(await canManage(project.projectKey))) {
      throw new UserFacingError(`Only a Jira site admin or a project administrator of ${project.projectKey} can clean the demo data.`);
    }
  }
  const projectKeys = projects.map((project) => project.projectKey);
  const owned = (issueKey: string) => projectKeys.some((projectKey) => issueKey.startsWith(`${projectKey}-`));

  const teamIds: string[] = [];
  for (const projectKey of projectKeys) {
    const teamId = await port.teamIdOf(projectKey);
    if (teamId) teamIds.push(teamId);
  }
  const requests = teamIds.length ? await port.requestsBetween(teamIds) : [];
  const requestIds = requests.map((request) => request.id);
  const contracts = requestIds.length ? await port.contractsOf(requestIds) : [];
  const contractIds = contracts.map((contract) => contract.id);

  const bugs = (await port.sprintDemoBugs(projectKeys)).filter(owned);
  if (bugs.length > 0) await port.moveToBacklog(bugs);

  const shift = await restoreShifted(port, requestIds, owned);
  const { restored: issuesRestored, kept } = shift;

  let links = 0;
  const recordedLinks = contractIds.length ? await port.recordedLinks(contractIds) : [];
  const uniqueLinks = [...new Map(recordedLinks.map((link) => [`${link.blocker}>${link.blocked}`, link])).values()];
  for (const link of uniqueLinks.filter((item) => owned(item.blocker) && owned(item.blocked))) {
    for (const linkId of await port.blocksLinkIds(link.blocker, link.blocked)) {
      await port.deleteLink(linkId);
      links += 1;
    }
  }

  let deliverablesArchived = 0;
  const recorded = contractIds.length ? await port.recordedDeliverables(contractIds) : new Set<string>();
  const deliverables = new Set(contracts.map((contract) => contract.deliverableIssueKey).filter((key): key is string => key !== null));
  for (const issueKey of [...deliverables].filter(owned)) {
    const state = await port.issueState(issueKey);
    if (!state || state.labels.includes(ARCHIVED_LABEL)) continue;
    // Only issues Accord created: recorded in the audit, or carrying the label every Accord deliverable gets.
    if (!recorded.has(issueKey) && !state.labels.includes(DELIVERABLE_LABEL)) continue;
    // Out of its sprint first: an archived deliverable must not stay in the sprint of the next take.
    await moveEach([issueKey], (keys) => port.moveToBacklog(keys));
    await port.archiveDeliverable(issueKey, state.done);
    deliverablesArchived += 1;
  }
  // Deliverables archived by an earlier clean that still sit in an open sprint.
  const leftovers = (await port.sprintArchivedDeliverables(projectKeys)).filter(owned);
  if (leftovers.length > 0) await moveEach(leftovers, (keys) => port.moveToBacklog(keys));

  const reopenSuggestionIds = await suggestionsToReopen(port, teamIds, owned);
  const { suggestions } = await port.deleteRows({ requestIds, contractIds, teamIds, shiftOriginIds: shift.settledIds, reopenSuggestionIds });

  // Only comments whose author is the app account itself; a person's comment is never removed. Runs after
  // the SQL rows are gone and is capped per run, so a long comment backlog cannot time out the clean;
  // comment markers stay in audit_log, so the next run finds what is left.
  let commentsRemoved = 0;
  let commentsLeft = false;
  const notRestored = [...NOT_RESTORED];
  if (kept.length > 0) {
    notRestored.unshift(`${kept.join(', ')} stayed where ${kept.length === 1 ? 'it is' : 'they are'}: the sprint ${kept.length === 1 ? 'it' : 'they'} came from is closed or no longer exists.`);
  }
  const skippedBy = (reason: 'done' | 'moved') => shift.skipped.filter((item) => item.reason === reason).map((item) => item.issueKey);
  if (skippedBy('moved').length > 0) notRestored.unshift(`Skipped ${skippedBy('moved').join(', ')}: moved by someone after the shift, so left where it is now.`);
  if (skippedBy('done').length > 0) notRestored.unshift(`Skipped ${skippedBy('done').join(', ')}: already Done.`);
  if (shift.failed.length > 0) notRestored.unshift(`Could not move ${shift.failed.join(', ')} back; run Clean demo data again to retry.`);
  const appAccountId = await port.appAccountId();
  if (appAccountId) {
    const commented = [...new Set(await port.commentedIssues())].filter(owned);
    const targets: Array<{ issueKey: string; id: string }> = [];
    for (const keys of batches(commented)) {
      const lists = await Promise.all(keys.map(async (issueKey) => ({ issueKey, comments: await port.listComments(issueKey) })));
      for (const { issueKey, comments } of lists) {
        for (const comment of comments) if (comment.authorAccountId === appAccountId) targets.push({ issueKey, id: comment.id });
      }
    }
    commentsLeft = targets.length > MAX_COMMENTS_PER_RUN;
    for (const group of batches(targets.slice(0, MAX_COMMENTS_PER_RUN))) {
      await Promise.all(group.map((target) => port.deleteComment(target.issueKey, target.id)));
      commentsRemoved += group.length;
    }
  } else {
    notRestored.unshift('Accord could not confirm its own Jira account, so no comments were removed.');
  }

  const summary =
    `Cleaned: ${plural(requests.length, 'request')}, ${plural(contracts.length, 'contract')}, ` +
    `${plural(links, 'link')}, ${plural(bugs.length, 'bug')} reset, ${plural(commentsRemoved, 'comment')} removed, ` +
    `restored ${plural(issuesRestored, 'moved issue')}` +
    (shift.skipped.length > 0 ? `, skipped ${shift.skipped.length} (${shift.skipped.map((item) => item.issueKey).join(', ')})` : '') +
    (shift.failed.length > 0 ? `, ${shift.failed.length} could not be moved back (${shift.failed.join(', ')})` : '') +
    (commentsLeft ? '. More Accord comments are left; run Clean demo data again.' : '');
  const result: DemoCleanResult = {
    projects: projectKeys,
    requests: requests.length,
    contracts: contracts.length,
    links,
    bugsReset: bugs.length,
    issuesRestored,
    commentsRemoved,
    deliverablesArchived,
    suggestions,
    suggestionsReopened: reopenSuggestionIds.length,
    summary,
    notRestored,
  };
  await port.audit('demo-cleaned', actor, { ...result, notRestored: undefined });
  return result;
}
