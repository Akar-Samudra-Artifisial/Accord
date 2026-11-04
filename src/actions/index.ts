import { computeCapacity, planOptions } from '../planner';
import { contracts, createRequestFromIssue, dealSheet } from '../resolvers/negotiation';
import { COST_CLASSES } from '../negotiation/orchestrator';
import { clientError } from '../errors';
import { DEMO_PAYMENTS_CHARTER, DEMO_SIMULATED_THROUGHPUT, demoPlannerInput } from '../demo/scenario';

/**
 * Rovo action handlers. Rovo passes action inputs as top-level payload fields.
 * M0: handlers answer from the demo scenario; persistence lands in M2.
 */
type ActionPayload = Record<string, unknown>;

/** Forge function context: Rovo passes the invoking user as `principal`. */
interface ActionContext {
  principal?: { accountId?: string };
}

interface ActionError {
  error: string;
}

function readString(payload: ActionPayload, name: string, required: boolean): string | undefined | ActionError {
  const value = payload[name];
  if (value === undefined || value === null || value === '') {
    return required ? { error: `Missing required input "${name}"` } : undefined;
  }
  if (typeof value !== 'string') {
    return { error: `Input "${name}" must be a string` };
  }
  return value.trim();
}

function isError(value: unknown): value is ActionError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export async function getTeamCharterAction(payload: ActionPayload) {
  const teamKey = readString(payload, 'teamKey', true);
  if (isError(teamKey)) return teamKey;
  // TODO(M2): load the parsed charter for teamKey from Forge SQL.
  return { teamKey, source: 'demo', charter: DEMO_PAYMENTS_CHARTER };
}

export async function getTeamCapacityAction(payload: ActionPayload) {
  const teamKey = readString(payload, 'teamKey', true);
  if (isError(teamKey)) return teamKey;
  // TODO(M2): compute from Jira sprint history (or stored simulated history).
  return { teamKey, source: 'Simulated history', capacity: computeCapacity(DEMO_SIMULATED_THROUGHPUT) };
}

export async function getRequestAction(payload: ActionPayload, context?: ActionContext) {
  const requestId = readString(payload, 'requestId', true);
  if (isError(requestId)) return requestId;
  try {
    const sheet = await dealSheet({ requestId }, context?.principal?.accountId);
    return {
      requestId,
      status: sheet.request.status,
      title: sheet.request.title,
      size: sheet.request.size,
      minSize: sheet.request.minSize,
      neededBy: sheet.request.neededBy,
      requester: sheet.requester.name,
      provider: sheet.provider.name,
      rounds: sheet.rounds,
      transcript: sheet.transcript,
      options: sheet.options.map(({ id, label, dateRange, meetsNeed, recommended, consequences, rulesUsed, explanation }) => ({
        id,
        label,
        dateRange,
        meetsNeed,
        recommended,
        consequences,
        rulesUsed,
        explanation,
      })),
      agreedOptionId: sheet.agreedOptionId,
      contract: sheet.contract,
    };
  } catch (error) {
    return { error: clientError('getRequest', error) };
  }
}

export async function evaluateOptionsAction(payload: ActionPayload) {
  const requestId = readString(payload, 'requestId', true);
  if (isError(requestId)) return requestId;
  const days = payload.earlierMinDays;
  if (days !== undefined && days !== null && !(Number.isInteger(days) && Number(days) > 0)) {
    return { error: 'Input "earlierMinDays" must be a positive integer' };
  }
  // TODO(M2): build PlannerInput from the stored request instead of the demo scenario.
  const result = planOptions(demoPlannerInput(typeof days === 'number' ? days : undefined));
  return { requestId, source: 'demo', ...result };
}

export async function listContractsAction(payload: ActionPayload, context?: ActionContext) {
  const teamKey = readString(payload, 'teamKey', false);
  if (isError(teamKey)) return teamKey;
  try {
    return { teamKey: teamKey ?? null, contracts: await contracts(context?.principal?.accountId, teamKey?.toUpperCase()) };
  } catch (error) {
    return { error: clientError('listContracts', error) };
  }
}

/** Creates the request only (no Jira change); the deal sheet still needs both team leads (NFR-2). */
export async function createDependencyRequestAction(payload: ActionPayload, context?: ActionContext) {
  const fields = ['sourceIssueKey', 'providerTeamKey', 'title', 'size', 'neededBy'] as const;
  for (const field of fields) {
    const value = readString(payload, field, true);
    if (isError(value)) return value;
  }
  const costClass = readString(payload, 'costClass', false);
  if (isError(costClass)) return costClass;
  if (costClass !== undefined && !(COST_CLASSES as readonly string[]).includes(costClass)) {
    return { error: `Input "costClass" must be one of ${COST_CLASSES.join(', ')}` };
  }
  try {
    const created = await createRequestFromIssue(
      { ...payload, minSize: payload.minSize ?? null, costClass: costClass ?? 'standard' },
      context?.principal?.accountId,
    );
    return { ...created, note: 'Negotiation started. Both team leads decide in the Accord deal sheet on the issue.' };
  } catch (error) {
    return { error: clientError('createDependencyRequest', error) };
  }
}
