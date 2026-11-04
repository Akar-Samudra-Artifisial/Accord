import Resolver from '@forge/resolver';
import { planOptions } from '../planner';
import { demoPlannerInput } from '../demo/scenario';
import { executeSeedStep, getSeedStatus } from '../demo/seed';
import { SEED_STEPS, type SeedStep } from '../demo/seed-data';
import { charterBylineState } from '../confluence/charter';
import { getPage } from '../confluence/pages';
import { getCharter, getTeamByKey, listTeams, type Team } from '../teams/repository';
import {
  createCharterPage,
  defaultCharterTemplate,
  refreshJiraThroughput,
  registerTeam,
  syncCharter,
  teamCapacity,
} from '../teams/service';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

interface RequestContext {
  accountId?: string;
  siteUrl?: string;
  extension?: { content?: { id?: string | number } };
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

function charterUrl(siteUrl: string | undefined, pageId: string | null): string | null {
  return pageId ? `${siteUrl ?? ''}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}` : null;
}

async function teamView(team: Team, siteUrl?: string) {
  const charter = await getCharter(team.id);
  const capacity = await teamCapacity(team);
  return {
    teamKey: team.teamKey,
    name: team.name,
    projectKey: team.jiraProjectKey,
    boardId: team.boardId,
    charter: {
      status: !team.charterPageId ? 'none' : charter?.valid ? 'valid' : 'invalid',
      missing: charter?.missingFields ?? [],
      pageId: team.charterPageId,
      url: charterUrl(siteUrl, team.charterPageId),
    },
    capacity,
  };
}

export type TeamView = Awaited<ReturnType<typeof teamView>>;

async function requireTeam(teamKey: unknown): Promise<Team> {
  if (typeof teamKey !== 'string' || !PROJECT_KEY.test(teamKey)) throw new Error('A valid team key is required.');
  const team = await getTeamByKey(teamKey);
  if (!team) throw new Error(`Team ${teamKey} is not registered in Accord.`);
  return team;
}

const resolver = new Resolver();

resolver.define('getPanelState', () => {
  // TODO(M3): look up the request linked to the current issue.
  return { status: 'none' };
});

resolver.define('getDemoOptions', () => planOptions(demoPlannerInput()));

resolver.define('getTeams', async ({ context }: { context: RequestContext }): Promise<Result<{ teams: TeamView[] }>> => {
  try {
    const teams = [];
    for (const team of await listTeams()) teams.push(await teamView(team, context.siteUrl));
    return { ok: true, teams };
  } catch (error) {
    return failure(error);
  }
});

resolver.define(
  'registerTeam',
  async ({ payload, context }: { payload: { projectKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const projectKey = typeof payload.projectKey === 'string' ? payload.projectKey.trim().toUpperCase() : '';
      if (!PROJECT_KEY.test(projectKey)) return { ok: false, error: 'Enter a Jira project key, for example PAY.' };
      const team = await registerTeam(projectKey);
      await refreshJiraThroughput(team);
      return { ok: true, team: await teamView(team, context.siteUrl) };
    } catch (error) {
      return failure(error);
    }
  },
);

resolver.define(
  'createCharterPage',
  async ({ payload, context }: { payload: { teamKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const team = await requireTeam(payload.teamKey);
      await createCharterPage(team, defaultCharterTemplate(team, context.accountId ?? team.leadAccountId), 'user');
      const updated = (await getTeamByKey(team.teamKey)) ?? team;
      return { ok: true, team: await teamView(updated, context.siteUrl) };
    } catch (error) {
      return failure(error);
    }
  },
);

resolver.define(
  'syncCharter',
  async ({ payload, context }: { payload: { teamKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const team = await requireTeam(payload.teamKey);
      await syncCharter(team);
      return { ok: true, team: await teamView(team, context.siteUrl) };
    } catch (error) {
      return failure(error);
    }
  },
);

resolver.define('getSeedStatus', async () => {
  try {
    return { ok: true, steps: await getSeedStatus() };
  } catch (error) {
    return failure(error);
  }
});

/** The UI runs the seed one step per call (each call is a separate, short invocation). */
resolver.define(
  'runSeedStep',
  async ({ payload, context }: { payload: { step?: unknown; adoptExisting?: unknown }; context: RequestContext }) => {
    try {
      const step = payload.step;
      if (typeof step !== 'string' || !(SEED_STEPS as readonly string[]).includes(step)) {
        return { ok: false, error: `Unknown seed step "${String(step)}"` };
      }
      const success = await executeSeedStep(step as SeedStep, {
        leadAccountId: context.accountId ?? null,
        adoptExisting: payload.adoptExisting === true,
        // Project creation falls back to the signed-in user (needs Jira admin).
        projectPrincipals: ['app', 'user'],
        today: new Date().toISOString().slice(0, 10),
      });
      return { ok: true, success, steps: await getSeedStatus() };
    } catch (error) {
      return failure(error);
    }
  },
);

resolver.define('getBylineState', async ({ context }: { context: RequestContext }) => {
  try {
    const pageId = context.extension?.content?.id;
    if (pageId === undefined || pageId === null) return { ok: false, error: 'No Confluence page in context.' };
    // No Forge SQL here: the Confluence installation has its own (empty) database,
    // team data lives in the Jira installation. Validate the page body directly.
    const page = await getPage(String(pageId));
    return { ok: true, ...charterBylineState(page.title, page.body?.storage?.value ?? '') };
  } catch (error) {
    console.error('getBylineState failed', error instanceof Error ? error.stack ?? error.message : error);
    return failure(error);
  }
});

export const resolverHandler = resolver.getDefinitions();
