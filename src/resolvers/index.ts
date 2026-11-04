import Resolver from '@forge/resolver';
import { clientError, UserFacingError } from '../errors';
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
  requireProjectAdmin,
  syncCharter,
  teamCapacity,
} from '../teams/service';
import {
  contracts,
  createRequestFromIssue,
  dealSheet,
  decideOnDealSheet,
  inbox,
  panelState,
  retryStalledRequest,
  type ResolverContext,
} from './negotiation';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

interface RequestContext extends ResolverContext {
  siteUrl?: string;
  extension?: ResolverContext['extension'] & { content?: { id?: string | number } };
}

/** Only user-facing messages reach the client; everything else is logged with a reference id. */
function failure(operation: string, error: unknown): { ok: false; error: string } {
  return { ok: false, error: clientError(operation, error) };
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
  if (typeof teamKey !== 'string' || !PROJECT_KEY.test(teamKey)) throw new UserFacingError('A valid team key is required.');
  const team = await getTeamByKey(teamKey);
  if (!team) throw new UserFacingError(`Team ${teamKey} is not registered in Accord.`);
  return team;
}

const resolver = new Resolver();

resolver.define('getPanelState', async ({ context }: { context: RequestContext }) => {
  try {
    return { ok: true, ...(await panelState(context)) };
  } catch (error) {
    return failure('getPanelState', error);
  }
});

resolver.define(
  'createRequest',
  async ({ payload, context }: { payload: Record<string, unknown>; context: RequestContext }) => {
    try {
      return { ok: true, ...(await createRequestFromIssue(payload, context.accountId)) };
    } catch (error) {
      return failure('createRequest', error);
    }
  },
);

resolver.define('getDealSheet', async ({ payload, context }: { payload: Record<string, unknown>; context: RequestContext }) => {
  try {
    return { ok: true, sheet: await dealSheet(payload, context.accountId) };
  } catch (error) {
    return failure('getDealSheet', error);
  }
});

resolver.define('decide', async ({ payload, context }: { payload: Record<string, unknown>; context: RequestContext }) => {
  try {
    return { ok: true, result: await decideOnDealSheet(payload, context.accountId) };
  } catch (error) {
    return failure('decide', error);
  }
});

resolver.define('retryRequest', async ({ payload, context }: { payload: Record<string, unknown>; context: RequestContext }) => {
  try {
    return { ok: true, result: await retryStalledRequest(payload, context.accountId) };
  } catch (error) {
    return failure('retryRequest', error);
  }
});

resolver.define('getInbox', async ({ context }: { context: RequestContext }) => {
  try {
    return { ok: true, items: await inbox(context.accountId) };
  } catch (error) {
    return failure('getInbox', error);
  }
});

resolver.define('getContracts', async ({ context }: { context: RequestContext }) => {
  try {
    return { ok: true, contracts: await contracts(context.accountId) };
  } catch (error) {
    return failure('getContracts', error);
  }
});

resolver.define('getDemoOptions', () => planOptions(demoPlannerInput()));

resolver.define('getTeams', async ({ context }: { context: RequestContext }): Promise<Result<{ teams: TeamView[] }>> => {
  try {
    const teams = [];
    for (const team of await listTeams()) teams.push(await teamView(team, context.siteUrl));
    return { ok: true, teams };
  } catch (error) {
    return failure('getTeams', error);
  }
});

resolver.define(
  'registerTeam',
  async ({ payload, context }: { payload: { projectKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const projectKey = typeof payload.projectKey === 'string' ? payload.projectKey.trim().toUpperCase() : '';
      if (!PROJECT_KEY.test(projectKey)) return { ok: false, error: 'Enter a Jira project key, for example PAY.' };
      await requireProjectAdmin(projectKey, context.accountId);
      const team = await registerTeam(projectKey);
      await refreshJiraThroughput(team);
      return { ok: true, team: await teamView(team, context.siteUrl) };
    } catch (error) {
      return failure('registerTeam', error);
    }
  },
);

resolver.define(
  'createCharterPage',
  async ({ payload, context }: { payload: { teamKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const team = await requireTeam(payload.teamKey);
      const project = await requireProjectAdmin(team.jiraProjectKey, context.accountId);
      // Default approver is the Jira project lead, never the caller (approvers come from the charter or the lead).
      const lead = project.lead?.accountId ?? team.leadAccountId;
      await createCharterPage(team, defaultCharterTemplate(team, lead), 'user');
      const updated = (await getTeamByKey(team.teamKey)) ?? team;
      return { ok: true, team: await teamView(updated, context.siteUrl) };
    } catch (error) {
      return failure('createCharterPage', error);
    }
  },
);

resolver.define(
  'syncCharter',
  async ({ payload, context }: { payload: { teamKey?: unknown }; context: RequestContext }): Promise<Result<{ team: TeamView }>> => {
    try {
      const team = await requireTeam(payload.teamKey);
      await requireProjectAdmin(team.jiraProjectKey, context.accountId);
      await syncCharter(team);
      return { ok: true, team: await teamView(team, context.siteUrl) };
    } catch (error) {
      return failure('syncCharter', error);
    }
  },
);

resolver.define('getSeedStatus', async () => {
  try {
    return { ok: true, steps: await getSeedStatus() };
  } catch (error) {
    return failure('getSeedStatus', error);
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
      return failure('runSeedStep', error);
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
    return failure('getBylineState', error);
  }
});

export const resolverHandler = resolver.getDefinitions();
