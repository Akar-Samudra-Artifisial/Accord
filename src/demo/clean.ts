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
  /** Deletes the SQL rows of these requests/contracts and the link suggestions between `teamIds`. */
  deleteRows(scope: { requestIds: readonly string[]; contractIds: readonly number[]; teamIds: readonly string[] }): Promise<{ suggestions: number }>;
  audit(action: string, actor: string | null, payload: unknown): Promise<void>;
}

export interface DemoCleanResult {
  projects: string[];
  requests: number;
  contracts: number;
  links: number;
  bugsReset: number;
  commentsRemoved: number;
  deliverablesArchived: number;
  suggestions: number;
  summary: string;
  /** What the clean deliberately leaves as it is (shown with the result). */
  notRestored: string[];
}

export const NOT_RESTORED = [
  'Comments written by people stay; only comments posted by the Accord app are removed.',
  'Issues moved to make room for a contract stay in their new sprint: Accord records only where they went, not where they came from.',
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
    await port.archiveDeliverable(issueKey, state.done);
    deliverablesArchived += 1;
  }

  const { suggestions } = await port.deleteRows({ requestIds, contractIds, teamIds });

  // Only comments whose author is the app account itself; a person's comment is never removed. Runs after
  // the SQL rows are gone and is capped per run, so a long comment backlog cannot time out the clean;
  // comment markers stay in audit_log, so the next run finds what is left.
  let commentsRemoved = 0;
  let commentsLeft = false;
  const notRestored = [...NOT_RESTORED];
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
    `${plural(links, 'link')}, ${plural(bugs.length, 'bug')} reset, ${plural(commentsRemoved, 'comment')} removed` +
    (commentsLeft ? '. More Accord comments are left; run Clean demo data again.' : '');
  const result: DemoCleanResult = {
    projects: projectKeys,
    requests: requests.length,
    contracts: contracts.length,
    links,
    bugsReset: bugs.length,
    commentsRemoved,
    deliverablesArchived,
    suggestions,
    summary,
    notRestored,
  };
  await port.audit('demo-cleaned', actor, { ...result, notRestored: undefined });
  return result;
}
