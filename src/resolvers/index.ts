import Resolver from '@forge/resolver';
import { clientError, UserFacingError } from '../errors';
import { planOptions } from '../planner';
import { demoPlannerInput } from '../demo/scenario';
import { executeSeedStep, existingDemoProjectKey, getSeedStatus, requireSeedAccess } from '../demo/seed';
import { SEED_STEPS, type SeedStep } from '../demo/seed-data';
import { charterBylineState } from '../confluence/charter';
import { getPage } from '../confluence/pages';
import { getApproverCheck, getCharter, getTeamByKey, listTeams, type Team } from '../teams/repository';
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
  auditTrail,
  contracts,
  createRequestFromIssue,
  dealSheet,
  decideOnDealSheet,
  dependencyMap,
  dependencySummary,
  dismissLinkSuggestion,
  inbox,
  awaitingRenegotiations,
  panelState,
  retryStalledRequest,
  type ResolverContext,
} from './negotiation';
import { teamDirectory } from '../negotiation/deps';
import { scheduleMonitor } from '../monitor/deps';
import { addDemoBugs, resetDemoBugs } from '../demo/critical-bugs';
import { demoBugPort, requireDemoBugPermissions } from '../demo/critical-bugs-port';
import { assignDemoLead, demoLeadPort, userCanManageDemoProjects, userSeedAccess } from '../demo/demo-lead';
import { cleanDemoData } from '../demo/clean';
import { demoCleanPort } from '../demo/clean-port';

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
  const approverCheck = await getApproverCheck(team.id);
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
      ignoredApprovers: approverCheck.ignoredCount,
      approversChangedAt: approverCheck.approversChangedAt,
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

resolver.define('dismissSuggestion', async ({ payload, context }: { payload: Record<string, unknown>; context: RequestContext }) => {
  try {
    return { ok: true, ...(await dismissLinkSuggestion(payload, context.accountId)) };
  } catch (error) {
    return failure('dismissSuggestion', error);
  }
});

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
    const [items, awaitingRenegotiation] = await Promise.all([inbox(context.accountId), awaitingRenegotiations(context.accountId)]);
    return { ok: true, items, awaitingRenegotiation };
  } catch (error) {
    return failure('getInbox', error);
  }
});

resolver.define('getContracts', async ({ context }: { context: RequestContext }) => {
  try {
    const rows = await contracts(context.accountId);
    return { ok: true, contracts: rows, dependencies: await dependencySummary(rows) };
  } catch (error) {
    return failure('getContracts', error);
  }
});

resolver.define('getDependencyMap', async ({ context }: { context: RequestContext }) => {
  try {
    return { ok: true, map: await dependencyMap(context.accountId) };
  } catch (error) {
    return failure('getDependencyMap', error);
  }
});

resolver.define('getAudit', async ({ context }: { context: RequestContext }) => {
  try {
    return { ok: true, entries: await auditTrail(context.accountId) };
  } catch (error) {
    return failure('getAudit', error);
  }
});

/** Queues the daily monitor now; allowed for approvers/leads of any registered team. */
resolver.define('runMonitorNow', async ({ context }: { context: RequestContext }) => {
  try {
    const accountId = context.accountId;
    if (!accountId) throw new UserFacingError('A signed-in Jira user is required.');
    let allowed = false;
    for (const team of await listTeams()) {
      if ((await teamDirectory.approvers(team)).includes(accountId)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw new UserFacingError('Only team approvers or project leads can run the contract monitor.');
    const teams = await scheduleMonitor('manual', accountId);
    return { ok: true, queuedTeams: teams.length };
  } catch (error) {
    return failure('runMonitorNow', error);
  }
});

resolver.define('addDemoBugs', async ({ context }: { context: RequestContext }) => {
  try {
    const projectKey = await existingDemoProjectKey('PAY');
    await requireProjectAdmin(projectKey, context.accountId);
    await requireDemoBugPermissions(projectKey);
    return { ok: true, ...(await addDemoBugs(demoBugPort, projectKey, context.accountId ?? null)) };
  } catch (error) {
    return failure('addDemoBugs', error);
  }
});

resolver.define('resetDemoBugs', async ({ context }: { context: RequestContext }) => {
  try {
    const projectKey = await existingDemoProjectKey('PAY');
    await requireProjectAdmin(projectKey, context.accountId);
    await requireDemoBugPermissions(projectKey);
    return { ok: true, ...(await resetDemoBugs(demoBugPort, projectKey, context.accountId ?? null)) };
  } catch (error) {
    return failure('resetDemoBugs', error);
  }
});

/** Whether the signed-in user may run "Make me the demo lead" (site admin or admin of the demo projects). */
resolver.define('getDemoLeadState', async ({ context }: { context: RequestContext }) => {
  try {
    if (!context.accountId) return { ok: true, canManage: false, projects: [] };
    const projects = await demoLeadPort.accordProjects();
    const canManage = await userCanManageDemoProjects();
    let allowed = projects.length > 0;
    for (const project of projects) allowed = allowed && (await canManage(project.projectKey));
    const leads = await Promise.all(projects.map((project) => demoLeadPort.projectLead(project.projectKey)));
    return {
      ok: true,
      canManage: allowed,
      projects: projects.map((project, index) => ({ ...project, isLead: leads[index] === context.accountId })),
    };
  } catch (error) {
    return failure('getDemoLeadState', error);
  }
});

resolver.define('makeMeDemoLead', async ({ context }: { context: RequestContext }) => {
  try {
    if (!context.accountId) throw new UserFacingError('A signed-in Jira user is required.');
    const results = await assignDemoLead(context.accountId, await userCanManageDemoProjects(), demoLeadPort);
    return { ok: true, results };
  } catch (error) {
    return failure('makeMeDemoLead', error);
  }
});

/** Admin only (site admin or project admin of every Accord demo project), checked here as the signed-in user. */
resolver.define('cleanDemoData', async ({ context }: { context: RequestContext }) => {
  try {
    if (!context.accountId) throw new UserFacingError('A signed-in Jira user is required.');
    return { ok: true, ...(await cleanDemoData(demoCleanPort, context.accountId, await userCanManageDemoProjects())) };
  } catch (error) {
    return failure('cleanDemoData', error);
  }
});

resolver.define('getDemoOptions', () => planOptions(demoPlannerInput()));

/**
 * Open to every signed-in user of the Accord page on purpose: it lists team names, project keys,
 * charter status and aggregate capacity, which anyone filing a dependency request needs to pick a
 * provider. No issue data is returned, and every write resolver checks project admin (NFR-3).
 */
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

/**
 * Seed status and plan. Everyone signed in sees the step list (no Jira data); only users who may seed
 * (site admin, or admin of every target project) get `canSeed`, and only they can run steps.
 */
resolver.define('getSeedStatus', async ({ payload, context }: { payload?: { adoptExisting?: unknown }; context: RequestContext }) => {
  try {
    const adoptExisting = payload?.adoptExisting === true;
    const steps = await getSeedStatus();
    let canSeed = true;
    let reason: string | null = null;
    let plan = null;
    try {
      plan = await requireSeedAccess(context.accountId, adoptExisting, userSeedAccess);
    } catch (error) {
      if (!(error instanceof UserFacingError)) throw error;
      canSeed = false;
      reason = error.message;
    }
    return { ok: true, steps, plan, canSeed, reason };
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
      // Server-side check on every step (NFR-3); hiding the button is not enough.
      await requireSeedAccess(context.accountId, payload.adoptExisting === true, userSeedAccess);
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
    // Read as the viewer so the byline never reveals a page the viewer cannot see (NFR-3).
    const page = await getPage(String(pageId), 'user');
    return { ok: true, ...charterBylineState(page.title, page.body?.storage?.value ?? '') };
  } catch (error) {
    return failure('getBylineState', error);
  }
});

export const resolverHandler = resolver.getDefinitions();
