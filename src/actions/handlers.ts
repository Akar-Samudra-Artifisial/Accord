import type { Principal } from '../atlassian/http';
import { clientError } from '../errors';
import { isValidIsoDate, type CostClass, type Size } from '../planner';
import { COST_CLASSES, MAX_TITLE_LENGTH, normalizeTitle } from '../negotiation/orchestrator';

/**
 * Rovo action handlers. Rovo passes action inputs as top-level payload fields and the invoking
 * user in the function context. Handlers only validate input and call the same services as the UI
 * (injected, so they can be tested without Forge); there is no approve action (NFR-2).
 */
export type ActionPayload = Record<string, unknown>;

/** Forge function context of a Rovo action: the invoking user is `principal` (older payloads: `accountId`). */
export interface ActionContext {
  principal?: { accountId?: string };
  accountId?: string;
}

/** Who the services act for: always the invoking Rovo/MCP user (`as: 'user'`, see `viewerFromContext`). */
export interface Viewer {
  accountId: string | undefined;
  as: Principal;
}

export interface CreateRequestInput {
  sourceIssueKey: string;
  providerTeamKey: string;
  title: string;
  size: Size;
  neededBy: string;
  minSize: number | null;
  costClass: CostClass;
}

/** A team registered in Accord, as shown to agents by `list-teams`. */
export interface TeamRef {
  teamKey: string;
  name: string;
  jiraProjectKey: string;
  /**
   * "full": the viewer is an approver/lead or can browse the team project. "restricted": the team exists
   * (as on the Teams tab) but only its name and aggregate capacity are shared.
   */
  access?: 'full' | 'restricted';
}

export interface ActionServices {
  /** Every team registered in Accord (keys and names only), marked with the viewer's access. */
  teams(viewer: Viewer): Promise<TeamRef[]>;
  teamCharter(teamKey: string, viewer: Viewer): Promise<unknown>;
  teamCapacity(teamKey: string, viewer: Viewer): Promise<unknown>;
  request(requestId: string, viewer: Viewer): Promise<unknown>;
  evaluateOptions(requestId: string, earlierMinDays: number | undefined, viewer: Viewer): Promise<unknown>;
  contracts(teamKey: string | undefined, viewer: Viewer): Promise<unknown>;
  createRequest(input: CreateRequestInput, viewer: Viewer): Promise<unknown>;
  /** What createRequest would create (resolved teams, title, dates); creates nothing. */
  previewRequest(input: CreateRequestInput, viewer: Viewer): Promise<unknown>;
}

/**
 * `confirm` of create-dependency-request: only boolean `true` (or the string "true" some clients send)
 * creates; anything else returns the preview.
 */
export function isConfirmed(payload: ActionPayload): boolean {
  const value = payload.confirm;
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

export interface ActionError {
  error: string;
}

export const REQUEST_ID = /^req-[0-9a-f-]{36}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]*$/;
export const SIZES: readonly Size[] = ['S', 'M', 'L'];
export const COST_CLASS_VALUES: readonly CostClass[] = COST_CLASSES;
/** Raw input bound before normalization (the stored title is cut to the orchestrator's MAX_TITLE_LENGTH). */
export const MAX_RAW_TITLE_LENGTH = 1000;
export const MAX_EARLIER_DAYS = 60;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function rawString(payload: ActionPayload, name: string, required: boolean): Parsed<string | undefined> {
  const value = payload[name];
  if (value === undefined || value === null || value === '') {
    return required ? fail(`Missing required input "${name}".`) : { ok: true, value: undefined };
  }
  if (typeof value !== 'string') return fail(`Input "${name}" must be a string.`);
  return { ok: true, value: value.trim() };
}

/** Team key or team name as typed (letters, digits, spaces, `_ . -`); resolved later against registered teams. */
const TEAM_REF = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u;

export function parseTeamRef(payload: ActionPayload, name: string, required: boolean): Parsed<string | undefined> {
  const raw = rawString(payload, name, required);
  if (!raw.ok || raw.value === undefined) return raw;
  const ref = raw.value.replace(/\s+/g, ' ');
  return TEAM_REF.test(ref)
    ? { ok: true, value: ref }
    : fail(`Input "${name}" must be an Accord team key or team name (call list-teams for the valid values).`);
}

/**
 * Resolves a team key or team name (case-insensitive) to the Accord team key. A key match wins;
 * otherwise exactly one team name must match. Errors list the valid teams.
 */
export function resolveTeamRef(ref: string, teams: readonly TeamRef[], inputName: string): Parsed<string> {
  const valid = teams.length ? `Valid teams: ${teams.map((team) => `${team.teamKey} (${team.name})`).join(', ')}.` : 'No teams are registered in Accord yet.';
  const byKey = teams.filter((team) => team.teamKey.toUpperCase() === ref.toUpperCase());
  if (byKey.length === 1) return { ok: true, value: byKey[0].teamKey };
  const byName = teams.filter((team) => team.name.trim().toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return { ok: true, value: byName[0].teamKey };
  if (byName.length > 1) return fail(`Input "${inputName}": the name "${ref}" matches several teams; use the team key. ${valid}`);
  return fail(`Input "${inputName}": no team registered in Accord is called "${ref}". ${valid}`);
}

export function parseRequestId(payload: ActionPayload): Parsed<string> {
  const raw = rawString(payload, 'requestId', true);
  if (!raw.ok) return raw;
  const id = (raw.value ?? '').toLowerCase();
  return REQUEST_ID.test(id) ? { ok: true, value: id } : fail('Input "requestId" must be an Accord request id (req-…).');
}

function parseInteger(payload: ActionPayload, name: string, min: number, max: number): Parsed<number | undefined> {
  const value = payload[name];
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    return fail(`Input "${name}" must be a whole number from ${min} to ${max}.`);
  }
  return { ok: true, value: number };
}

export function parseEarlierMinDays(payload: ActionPayload): Parsed<number | undefined> {
  return parseInteger(payload, 'earlierMinDays', 1, MAX_EARLIER_DAYS);
}

export function parseCreateInput(payload: ActionPayload): Parsed<CreateRequestInput> {
  const issue = rawString(payload, 'sourceIssueKey', true);
  if (!issue.ok) return issue;
  const sourceIssueKey = (issue.value ?? '').toUpperCase();
  if (!ISSUE_KEY.test(sourceIssueKey)) return fail('Input "sourceIssueKey" must be a Jira issue key such as MOB-1.');
  const provider = parseTeamRef(payload, 'providerTeamKey', true);
  if (!provider.ok) return provider;
  // Optional: without a title the request is named after the source issue summary.
  const title = rawString(payload, 'title', false);
  if (!title.ok) return title;
  if ((title.value ?? '').length > MAX_RAW_TITLE_LENGTH) return fail(`Input "title" must be at most ${MAX_RAW_TITLE_LENGTH} characters (it is shortened to ${MAX_TITLE_LENGTH}).`);
  const titleValue = normalizeTitle(title.value ?? '');
  if (title.value !== undefined && !titleValue) return fail('Input "title" must contain text.');
  const size = rawString(payload, 'size', true);
  if (!size.ok) return size;
  const sizeValue = (size.value ?? '').toUpperCase() as Size;
  if (!SIZES.includes(sizeValue)) return fail('Input "size" must be one of S, M, L.');
  const neededBy = rawString(payload, 'neededBy', true);
  if (!neededBy.ok) return neededBy;
  if (!isValidIsoDate(neededBy.value ?? '')) return fail('Input "neededBy" must be a date in YYYY-MM-DD format.');
  const minSize = parseInteger(payload, 'minSize', 1, 6);
  if (!minSize.ok) return minSize;
  const cost = rawString(payload, 'costClass', false);
  if (!cost.ok) return cost;
  const costClass = (cost.value ?? 'standard').toLowerCase() as CostClass;
  if (!COST_CLASS_VALUES.includes(costClass)) return fail(`Input "costClass" must be one of ${COST_CLASS_VALUES.join(', ')}.`);
  return {
    ok: true,
    value: {
      sourceIssueKey,
      providerTeamKey: provider.value as string,
      title: titleValue,
      size: sizeValue,
      neededBy: neededBy.value as string,
      minSize: minSize.value ?? null,
      costClass,
    },
  };
}

export function viewerFromContext(context: ActionContext | undefined): Viewer {
  return { accountId: context?.principal?.accountId ?? context?.accountId, as: 'user' };
}

async function guarded(operation: string, work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    return { error: clientError(operation, error) } satisfies ActionError;
  }
}

/** Builds the action handlers; Rovo and MCP entry points pass `viewerFromContext(context)`. */
export function createActionHandlers(services: ActionServices) {
  /** Resolves a team reference against the registered teams, then runs `work` with the Accord key. */
  const withTeam = (operation: string, viewer: Viewer, ref: string, inputName: string, work: (teamKey: string) => Promise<unknown>) =>
    guarded(operation, async () => {
      // Every registered team resolves, as on the Teams tab; services decide what a restricted viewer gets.
      const resolved = resolveTeamRef(ref, await services.teams(viewer), inputName);
      return resolved.ok ? work(resolved.value) : ({ error: resolved.error } satisfies ActionError);
    });

  return {
    async listTeams(viewer: Viewer) {
      return guarded('listTeams', async () => ({ teams: await services.teams(viewer) }));
    },
    async getTeamCharter(payload: ActionPayload, viewer: Viewer) {
      const teamKey = parseTeamRef(payload, 'teamKey', true);
      if (!teamKey.ok) return { error: teamKey.error };
      return withTeam('getTeamCharter', viewer, teamKey.value as string, 'teamKey', (key) => services.teamCharter(key, viewer));
    },
    async getTeamCapacity(payload: ActionPayload, viewer: Viewer) {
      const teamKey = parseTeamRef(payload, 'teamKey', true);
      if (!teamKey.ok) return { error: teamKey.error };
      return withTeam('getTeamCapacity', viewer, teamKey.value as string, 'teamKey', (key) => services.teamCapacity(key, viewer));
    },
    async getRequest(payload: ActionPayload, viewer: Viewer) {
      const requestId = parseRequestId(payload);
      if (!requestId.ok) return { error: requestId.error };
      return guarded('getRequest', () => services.request(requestId.value, viewer));
    },
    async evaluateOptions(payload: ActionPayload, viewer: Viewer) {
      const requestId = parseRequestId(payload);
      if (!requestId.ok) return { error: requestId.error };
      const days = parseEarlierMinDays(payload);
      if (!days.ok) return { error: days.error };
      return guarded('evaluateOptions', () => services.evaluateOptions(requestId.value, days.value, viewer));
    },
    async listContracts(payload: ActionPayload, viewer: Viewer) {
      const teamKey = parseTeamRef(payload, 'teamKey', false);
      if (!teamKey.ok) return { error: teamKey.error };
      if (teamKey.value === undefined) return guarded('listContracts', () => services.contracts(undefined, viewer));
      return withTeam('listContracts', viewer, teamKey.value, 'teamKey', (key) => services.contracts(key, viewer));
    },
    /** Without `confirm: true` only a preview is returned; nothing is created (MCP clients call it twice). */
    async createDependencyRequest(payload: ActionPayload, viewer: Viewer) {
      const input = parseCreateInput(payload);
      if (!input.ok) return { error: input.error };
      const confirmed = isConfirmed(payload);
      return withTeam('createDependencyRequest', viewer, input.value.providerTeamKey, 'providerTeamKey', (providerTeamKey) =>
        confirmed ? services.createRequest({ ...input.value, providerTeamKey }, viewer) : services.previewRequest({ ...input.value, providerTeamKey }, viewer),
      );
    },
  };
}

export type ActionHandlers = ReturnType<typeof createActionHandlers>;
