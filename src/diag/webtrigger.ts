/**
 * Development-only diagnostics web trigger (`accord-dev-diag`).
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
import { getCharter, listTeams } from '../teams/repository';
import { executeSeedStep, getSeedStatus, SEED_QUEUE_KEY, startSeed } from '../demo/seed';
import { SEED_STEPS, type SeedStep } from '../demo/seed-data';

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

async function status() {
  const tables = ['teams', 'charters', 'throughput_samples', 'requests', 'audit_log', 'demo_seed_steps'];
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
  return { counts, teams, seed: await getSeedStatus(), lastQueuePing: ping ?? null };
}

export async function devDiagHandler(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  const action = request.queryParameters?.action?.[0] ?? 'status';
  let body: unknown;
  try {
    if (action === 'spike') body = await spikes();
    else if (action === 'seed') {
      body = await startSeed({ leadAccountId: null, adoptExisting: request.queryParameters?.adopt?.[0] === '1' });
    } else if (action === 'seed-step') {
      // Synchronous single step (bypasses the queue); one step stays well under the time limit.
      const step = request.queryParameters?.step?.[0];
      if (!step || !(SEED_STEPS as readonly string[]).includes(step)) throw new Error(`Unknown step "${step}"`);
      const ok = await executeSeedStep(step as SeedStep, {
        leadAccountId: null,
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
    } else body = await status();
  } catch (error) {
    body = { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify({ action, result: body }, null, 2),
  };
}
