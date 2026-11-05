/**
 * Development-only diagnostics web trigger (`accord-dev-diag`). Disabled unless the Forge
 * variable ACCORD_DIAG_ENABLED is `true` (set only in the development environment).
 * TODO(before production): remove this module, its manifest entry and the
 * `dev-diag` function. Never commit the web trigger URL.
 */
import { route, type WebTriggerRequest, type WebTriggerResponse } from '@forge/api';
import { Queue } from '@forge/events';
import { migrationRunner } from '@forge/sql';
import { jira } from '../atlassian/http';
import { ensureSchema, select } from '../sql/db';
import { createPage, findPageByTitle, getPage, getPageLabels } from '../confluence/pages';
import { charterBylineState } from '../confluence/charter';
import { ensureCharterSpace, loadCommitments, teamCapacity } from '../teams/service';
import { getCharter, getTeamByKey, getTeamByProjectKey, listTeams } from '../teams/repository';
import { randomUUID } from 'node:crypto';
import { productionDeps } from '../negotiation/deps';
import { createRequest } from '../negotiation/orchestrator';
import { requestsByStatus } from '../negotiation/store';
import { deleteIssueLink, isBlocksFrom, ISSUE_KEY, linkBlocks, listIssueLinks, type IssueLink } from '../jira/issues';
import type { CostClass, Size } from '../planner';
import { executeSeedStep, existingDemoProjectKey, getSeedPlan, getSeedStatus, SEED_QUEUE_KEY, startSeed } from '../demo/seed';
import { MIGRATIONS } from '../sql/migrations';
import { ACCOUNT_ID, assignDemoLead, demoLeadPort } from '../demo/demo-lead';
import { parseCreateInput, resolveTeamRef } from '../actions/handlers';
import { defaultTitle } from '../resolvers/negotiation';
import { actionServices, links } from '../actions/services';
import { contractLinks } from '../actions/links';
import { listContracts as listStoredContracts } from '../negotiation/store';
import { SEED_STEPS, type SeedStep } from '../demo/seed-data';
import { addDemoBugs, resetDemoBugs } from '../demo/critical-bugs';
import { demoBugPort } from '../demo/critical-bugs-port';
import { monitorDeps, scheduleMonitor, sqlMonitorStore } from '../monitor/deps';
import { monitorProviderTeam } from '../monitor/monitor';
import { actionHandlers } from '../actions';
import { listSprints, moveIssuesToBacklog, moveIssuesToSprint } from '../jira/sprints';
import { UserFacingError } from '../errors';
import { getIssue, listSprintIssues } from '../jira/issues';

type Check = { ok: true; detail: unknown } | { ok: false; error: string };

async function check(fn: () => Promise<unknown>): Promise<Check> {
  try {
    return { ok: true, detail: await fn() };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const extra = error && typeof error === 'object' ? JSON.stringify(error).slice(0, 500) : '';
    return { ok: false, error: extra && extra !== '{}' ? `${message} ${extra}` : message };
  }
}

async function spikes() {
  const sqlCheck = await check(async () => {
    const applied = await ensureSchema();
    const migrations = await migrationRunner.list();
    const [row] = await select<{ n: number }>('SELECT COUNT(*) AS n FROM teams');
    const recorded = await select<{ name: string; n: number }>(
      'SELECT name, COUNT(*) AS n FROM __migrations GROUP BY name ORDER BY name',
    );
    return {
      appliedNow: applied,
      listed: migrations.length,
      recorded: recorded.map((r) => `${r.name}x${r.n}`),
      teamsRows: Number(row.n),
    };
  });
  const agileCheck = await check(async () => {
    const boards = await jira<{ values: Array<{ id: number; name: string; type: string }> }>(
      route`/rest/agile/1.0/board?maxResults=10`,
    );
    const scrum = boards.values.find((board) => board.type === 'scrum');
    if (!scrum) return { boards: boards.values, note: 'no scrum board to inspect' };
    const sprints = await jira<{ values: Array<{ id: number; name: string; state: string }> }>(
      route`/rest/agile/1.0/board/${scrum.id}/sprint?maxResults=50`,
    );
    const sprint = sprints.values[0];
    const issues = sprint
      ? await jira<{ total: number }>(route`/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=1&fields=summary`)
      : null;
    return { boards: boards.values.length, scrumBoard: scrum.id, sprints: sprints.values.length, firstSprintIssues: issues?.total };
  });
  const queueCheck = await check(async () => {
    const { jobId } = await new Queue({ key: SEED_QUEUE_KEY }).push({ body: { kind: 'ping', sentAt: new Date().toISOString() } });
    return { jobId, verify: 'call ?action=status and look at lastQueuePing' };
  });
  const negotiationQueueCheck = await check(async () => {
    const { jobId } = await new Queue({ key: 'accord-negotiation' }).push([{ body: { ping: true } }]);
    return { jobId };
  });
  const confluenceCheck = await check(async () => {
    const space = await ensureCharterSpace();
    const title = 'Accord spike page';
    const page =
      (await findPageByTitle(space.id, title)) ??
      (await createPage(space.id, title, '<h2>Spike</h2><p>Created by the Accord M0 spike.</p>'));
    const read = await getPage(page.id);
    return { space: space.key, pageId: page.id, storageChars: read.body?.storage?.value.length ?? 0 };
  });
  return { sql: sqlCheck, agile: agileCheck, queue: queueCheck, negotiationQueue: negotiationQueueCheck, confluence: confluenceCheck };
}

async function status(adoptExisting: boolean) {
  const tables = ['teams', 'charters', 'throughput_samples', 'requests', 'contracts', 'audit_log', 'demo_seed_steps'];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = Number(row.n);
  }
  const teams = [];
  for (const team of await listTeams()) {
    const charter = await getCharter(team.id);
    const labels = team.charterPageId ? await check(() => getPageLabels(team.charterPageId as string)) : null;
    const capacity = await check(() => teamCapacity(team));
    const commitments = await check(async () => {
      const result = await loadCommitments(team);
      return {
        sprints: result.sprints.map((s) => `${s.id}:${s.name}:${s.state}:${s.startDate}..${s.endDate}`),
        openCommitted: result.commitments.length,
      };
    });
    teams.push({
      key: team.teamKey,
      boardId: team.boardId,
      charterPageId: team.charterPageId,
      leadAccountId: team.leadAccountId,
      approvers: charter?.charter?.approvers ?? null,
      charterValid: charter?.valid ?? null,
      charterMissing: charter?.missingFields ?? null,
      labels,
      capacity,
      commitments,
    });
  }
  const [ping] = await select<{ payload: unknown; created_at: string }>(
    "SELECT payload, created_at FROM audit_log WHERE action = 'queue-ping' ORDER BY id DESC LIMIT 1",
  );
  const applied = new Set((await select<{ name: string }>('SELECT name FROM __migrations')).map((row) => row.name));
  const migrations = { applied: applied.size, pending: MIGRATIONS.map((m) => m.name).filter((name) => !applied.has(name)) };
  const seedPlan = await check(() => getSeedPlan(adoptExisting));
  return { counts, migrations, teams, seedPlan, seed: await getSeedStatus(), lastQueuePing: ping ?? null };
}

const param = (query: Record<string, string[]>, name: string, fallback: string): string => query[name]?.[0] ?? fallback;

/** Demo lead for diag seeds: explicit `?lead=` or the development owner variable; null = first human project lead. */
function diagLead(query: Record<string, string[]>): string | null {
  const lead = query.lead?.[0] ?? process.env.ACCORD_DEV_OWNER_ACCOUNT_ID ?? null;
  if (lead !== null && !ACCOUNT_ID.test(lead)) throw new UserFacingError('Invalid ?lead account id.');
  return lead;
}

/**
 * Creates a dependency request through the same service as the issue panel. The app is the
 * creator (`diag-webtrigger`); approvals still need the real leads in the browser.
 */
async function diagCreateRequest(query: Record<string, string[]>) {
  const sourceIssueKey = param(query, 'issue', '').toUpperCase();
  const requesterTeam = await getTeamByProjectKey(sourceIssueKey.slice(0, sourceIssueKey.lastIndexOf('-')));
  const providerTeam = await getTeamByKey(param(query, 'provider', 'PAY').toUpperCase());
  if (!requesterTeam || !providerTeam) throw new Error('Unknown requester project or provider team');
  const min = query.min?.[0];
  const request = await createRequest(
    productionDeps,
    {
      sourceIssueKey,
      requesterTeam,
      providerTeam,
      title: param(query, 'title', 'Diag dependency request'),
      size: param(query, 'size', 'M').toUpperCase() as Size,
      minSize: min ? Number(min) : null,
      neededBy: param(query, 'neededBy', ''),
      costClass: param(query, 'cost', 'standard') as CostClass,
      createdBy: 'diag-webtrigger',
    },
    `req-${randomUUID()}`,
  );
  return { requestId: request.id, status: request.status, createdAt: request.createdAt };
}

async function diagRequest(id: string) {
  const { store } = productionDeps;
  const request = await store.getRequest(id);
  if (!request) throw new Error(`Request ${id} not found`);
  const rounds = await store.listRounds(id);
  const options = await store.listOptions(id);
  return {
    request,
    rounds: rounds.map((r) => ({ round: r.roundNo, role: r.role, status: r.status, error: r.error, createdAt: r.createdAt })),
    options: options.map((o) => ({
      id: o.id,
      kind: o.kind,
      dateRange: o.dateRange,
      shifted: o.shifted.map((item) => `${item.key}→${item.toSprintId}`),
      meetsNeed: o.meetsNeed,
      recommended: o.recommended,
    })),
    approvals: await store.listApprovals(id),
    contract: await store.getContract(id),
  };
}

/**
 * Creates "blocker blocks blocked" with the production `linkBlocks`, reads the link back from both
 * issues (as Jira's UI labels it) and deletes it again unless `keep=1`.
 */
async function verifyBlocksLink(query: Record<string, string[]>) {
  const blocker = param(query, 'blocker', '').toUpperCase();
  const blocked = param(query, 'blocked', '').toUpperCase();
  if (!ISSUE_KEY.test(blocker) || !ISSUE_KEY.test(blocked)) throw new Error('Need ?blocker=KEY&blocked=KEY');
  const describe = (key: string, links: IssueLink[]) =>
    links
      .filter((link) => link.type.name === 'Blocks')
      .map((link) => ({
        id: link.id,
        reads: link.outwardIssue
          ? `${key} ${link.type.outward} ${link.outwardIssue.key}`
          : `${key} ${link.type.inward} ${link.inwardIssue?.key}`,
      }));
  const existed = (await listIssueLinks(blocker)).some((link) => isBlocksFrom(link, blocked));
  if (!existed) await linkBlocks(blocker, blocked);
  const fromBlocker = await listIssueLinks(blocker);
  const fromBlocked = await listIssueLinks(blocked);
  const created = fromBlocker.find((link) => link.type.name === 'Blocks' && (link.outwardIssue?.key === blocked || link.inwardIssue?.key === blocked));
  const result = {
    expected: `${blocker} blocks ${blocked}`,
    hasBlocksLink: fromBlocker.some((link) => isBlocksFrom(link, blocked)),
    blocker: describe(blocker, fromBlocker),
    blocked: describe(blocked, fromBlocked),
    existedBefore: existed,
    deleted: false,
  };
  if (!existed && created?.id && query.keep?.[0] !== '1') {
    await deleteIssueLink(created.id);
    result.deleted = true;
  }
  return result;
}

/** Runs the monitor inline for every provider team (same code path as the queue consumer). */
async function diagMonitor() {
  const teamIds = await sqlMonitorStore.providersWithContracts();
  await productionDeps.store.audit('monitor', 'daily', 'monitor-started', 'diag-webtrigger', { trigger: 'diag', teams: teamIds });
  const results = [];
  for (const teamId of teamIds) results.push(await monitorProviderTeam(monitorDeps, teamId));
  return results;
}

/** Calls every Rovo action handler as the app (no user principal in a web trigger). */
async function diagActions(query: Record<string, string[]>) {
  const teamKey = param(query, 'team', 'PAY').toUpperCase();
  // No user identity is ever borrowed: user-scoped actions answer "signed-in user required" here.
  const viewer = { accountId: undefined, as: 'app' as const };
  const requestId = param(query, 'id', '');
  const result: Record<string, unknown> = {
    actingAs: 'app without user',
    listTeams: await actionHandlers.listTeams(),
    // Same resolution create-dependency-request uses for providerTeamKey (key or team name).
    resolvedProvider: resolveTeamRef(param(query, 'provider', 'PAY'), await actionServices.teams(), 'providerTeamKey'),
    // The user-scoped actions return nothing here; these are the links list-contracts adds to each row.
    contractUrls: await (async () => {
      const site = await links();
      return (await listStoredContracts()).map(({ contract, request }) => ({
        contractId: contract.id,
        sourceIssueKey: request.sourceIssueKey,
        deliverableIssueKey: contract.deliverableIssueKey,
        ...contractLinks(site, { sourceIssueKey: request.sourceIssueKey, deliverableIssueKey: contract.deliverableIssueKey }),
      }));
    })(),
    getTeamCharter: await actionHandlers.getTeamCharter({ teamKey }, viewer),
    getTeamCapacity: await actionHandlers.getTeamCapacity({ teamKey }, viewer),
    listContracts: await actionHandlers.listContracts({ teamKey }, viewer),
    invalidTeamKey: await actionHandlers.getTeamCharter({ teamKey: 'pay; drop' }, viewer),
    invalidCostClass: await actionHandlers.createDependencyRequest(
      { sourceIssueKey: 'MOB-1', providerTeamKey: 'PAY', title: 'x', size: 'S', neededBy: '2026-11-20', costClass: 'urgent' },
      viewer,
    ),
  };
  const titleIssue = param(query, 'titleIssue', '').toUpperCase();
  if (ISSUE_KEY.test(titleIssue)) {
    // Same parsing + title fallback as create-dependency-request, without creating a request.
    const given = param(query, 'title', '(summary of the source issue)');
    const parsed = parseCreateInput({ sourceIssueKey: titleIssue, providerTeamKey: 'PAY', title: given, size: 'S', neededBy: '2026-12-31', costClass: 'standard' });
    const summary = (await getIssue(titleIssue)).fields.summary;
    result.titlePreview = parsed.ok
      ? { given, sourceIssueSummary: summary ?? null, title: defaultTitle(parsed.value.title, summary, titleIssue) }
      : parsed;
  }
  if (requestId) {
    result.getRequest = await actionHandlers.getRequest({ requestId }, viewer);
    result.evaluateOptions = await actionHandlers.evaluateOptions({ requestId, earlierMinDays: query.earlier?.[0] ? Number(query.earlier[0]) : undefined }, viewer);
  }
  if (query.create?.[0] === '1') {
    result.createDependencyRequest = await actionHandlers.createDependencyRequest(
      {
        sourceIssueKey: param(query, 'issue', 'MOB-1'),
        providerTeamKey: param(query, 'provider', 'PAY'),
        title: param(query, 'title', 'Rovo action diag request'),
        size: param(query, 'size', 'S'),
        neededBy: param(query, 'neededBy', ''),
        costClass: param(query, 'cost', 'standard'),
      },
      viewer,
    );
  }
  return result;
}

/**
 * Moves one issue to a sprint with the production `moveIssuesToSprint` (Agile API), reads the target
 * sprint back and moves it to its original sprint again unless `keep=1`.
 */
async function verifySprintMove(query: Record<string, string[]>) {
  const issueKey = param(query, 'issue', '').toUpperCase();
  const sprintId = Number(param(query, 'sprint', ''));
  if (!ISSUE_KEY.test(issueKey) || !Number.isInteger(sprintId) || sprintId <= 0) throw new Error('Need ?issue=KEY&sprint=<id>');
  const team = await getTeamByProjectKey(issueKey.slice(0, issueKey.lastIndexOf('-')));
  if (!team?.boardId) throw new Error(`No Accord team with a board for ${issueKey}`);
  const sprints = await listSprints(team.boardId, ['active', 'future']);
  if (!sprints.some((sprint) => sprint.id === sprintId)) throw new Error(`Sprint ${sprintId} is not an open sprint of board ${team.boardId}`);
  const contains = async (id: number) => (await listSprintIssues(id)).some((issue) => issue.key === issueKey);
  // The Agile sprint-issue listing is eventually consistent (observed ~10 s lag after a move).
  const eventually = async (id: number) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await contains(id)) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  };
  let originalSprintId: number | null = null;
  for (const sprint of sprints) {
    if (await contains(sprint.id)) {
      originalSprintId = sprint.id;
      break;
    }
  }
  await moveIssuesToSprint(sprintId, [issueKey]);
  const inTargetAfterMove = await eventually(sprintId);
  const result: Record<string, unknown> = { issueKey, originalSprintId, targetSprintId: sprintId, inTargetAfterMove, movedBack: false };
  if (query.keep?.[0] === '1' || originalSprintId === sprintId) return result;
  if (originalSprintId !== null) {
    await moveIssuesToSprint(originalSprintId, [issueKey]);
    result.movedBack = await eventually(originalSprintId);
    result.returnedTo = `sprint ${originalSprintId}`;
  } else {
    // Not in an open sprint before the move: it came from the backlog, so it goes back there.
    await moveIssuesToBacklog([issueKey]);
    result.movedBack = !(await contains(sprintId));
    result.returnedTo = 'backlog';
  }
  return result;
}

export async function devDiagHandler(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  // The web trigger URL is public: everything is refused unless the development-only variable is set.
  if (process.env.ACCORD_DIAG_ENABLED !== 'true') {
    return { statusCode: 404, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ error: 'Not found' }) };
  }
  const action = request.queryParameters?.action?.[0] ?? 'status';
  let body: unknown;
  try {
    if (action === 'spike') body = await spikes();
    else if (action === 'seed') {
      body = await startSeed({ leadAccountId: diagLead(request.queryParameters ?? {}), adoptExisting: request.queryParameters?.adopt?.[0] === '1' });
    } else if (action === 'seed-step') {
      // Synchronous single step (bypasses the queue); one step stays well under the time limit.
      const step = request.queryParameters?.step?.[0];
      if (!step || !(SEED_STEPS as readonly string[]).includes(step)) throw new Error(`Unknown step "${step}"`);
      const ok = await executeSeedStep(step as SeedStep, {
        leadAccountId: diagLead(request.queryParameters ?? {}),
        adoptExisting: request.queryParameters?.adopt?.[0] === '1',
        projectPrincipals: ['app'],
        today: new Date().toISOString().slice(0, 10),
      });
      body = { ok, seed: await getSeedStatus() };
    } else if (action === 'byline') {
      // Same computation as the getBylineState resolver (run via the Confluence installation).
      const pageId = request.queryParameters?.page?.[0];
      if (!pageId) throw new Error('Missing ?page=<id>');
      const page = await getPage(pageId);
      body = charterBylineState(page.title, page.body?.storage?.value ?? '');
    } else if (action === 'create-request') {
      body = await diagCreateRequest(request.queryParameters ?? {});
    } else if (action === 'verify-blocks-link') {
      body = await verifyBlocksLink(request.queryParameters ?? {});
    } else if (action === 'monitor') {
      body = request.queryParameters?.queue?.[0] === '1'
        ? { queuedTeams: await scheduleMonitor('diag', 'diag-webtrigger') }
        : await diagMonitor();
    } else if (action === 'demo-bugs') {
      body = request.queryParameters?.op?.[0] === 'reset'
        ? await resetDemoBugs(demoBugPort, await existingDemoProjectKey('PAY'), 'diag-webtrigger')
        : await addDemoBugs(demoBugPort, await existingDemoProjectKey('PAY'), 'diag-webtrigger');
    } else if (action === 'demo-lead') {
      // Assigns demo data ownership only (project lead + charter approver); no user identity is borrowed.
      const lead = diagLead(request.queryParameters ?? {});
      if (!lead) throw new UserFacingError('Pass ?lead=<accountId> or set ACCORD_DEV_OWNER_ACCOUNT_ID.');
      body = await assignDemoLead(lead, async () => true, demoLeadPort);
    } else if (action === 'user-search') {
      const query = request.queryParameters?.query?.[0];
      if (!query) throw new UserFacingError('Missing ?query=<name or email>');
      const users = await jira<Array<{ accountId: string; displayName?: string; accountType?: string }>>(
        route`/rest/api/3/user/search?query=${query}&maxResults=5`,
      );
      body = users.map(({ accountId, displayName, accountType }) => ({ accountId, displayName, accountType }));
    } else if (action === 'actions') {
      body = await diagActions(request.queryParameters ?? {});
    } else if (action === 'verify-sprint-move') {
      body = await verifySprintMove(request.queryParameters ?? {});
    } else if (action === 'audit') {
      const id = request.queryParameters?.id?.[0];
      body = id ? await select('SELECT id, entity_type, entity_id, action, created_at FROM audit_log WHERE entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 30', [id])
        : await select('SELECT id, entity_type, entity_id, action, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 30', []);
    } else if (action === 'request') {
      const id = request.queryParameters?.id?.[0];
      body = id ? await diagRequest(id) : await requestsByStatus(['negotiating', 'awaiting-approval', 'approved', 'contracted', 'rejected', 'failed'], 10);
    } else body = await status(request.queryParameters?.adopt?.[0] === '1');
  } catch (error) {
    // Details only in the Forge log; the public response stays generic (user-facing messages excepted).
    const ref = randomUUID().slice(0, 8);
    console.error(`Accord diag action ${action} failed (ref ${ref})`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    body = error instanceof UserFacingError ? { error: error.message, ref } : { error: 'Diagnostic action failed', ref };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify({ action, result: body }, null, 2),
  };
}
