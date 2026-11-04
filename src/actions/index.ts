import { computeCapacity, isValidIsoDate, planOptions } from '../planner';
import { DEMO_PAYMENTS_CHARTER, DEMO_SIMULATED_THROUGHPUT, demoPlannerInput } from '../demo/scenario';

/**
 * Rovo action handlers. Rovo passes action inputs as top-level payload fields.
 * M0: handlers answer from the demo scenario; persistence lands in M2.
 */
type ActionPayload = Record<string, unknown>;

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

export async function getRequestAction(payload: ActionPayload) {
  const requestId = readString(payload, 'requestId', true);
  if (isError(requestId)) return requestId;
  // TODO(M2): read request and negotiation rounds from Forge SQL.
  return { requestId, status: 'not-found', note: 'Request storage is not implemented yet (M2).' };
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

export async function listContractsAction(payload: ActionPayload) {
  const teamKey = readString(payload, 'teamKey', false);
  if (isError(teamKey)) return teamKey;
  // TODO(M3): list contracts from Forge SQL.
  return { teamKey: teamKey ?? null, contracts: [] };
}

export async function createDependencyRequestAction(payload: ActionPayload) {
  const fields = ['sourceIssueKey', 'providerTeamKey', 'title', 'size', 'neededBy'] as const;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = readString(payload, field, true);
    if (isError(value)) return value;
    values[field] = value ?? '';
  }
  if (!['S', 'M', 'L'].includes(values.size)) {
    return { error: 'Input "size" must be S, M or L' };
  }
  if (!isValidIsoDate(values.neededBy)) {
    return { error: 'Input "neededBy" must be a date in YYYY-MM-DD format' };
  }
  // TODO(M2): persist the request and enqueue negotiation round 1.
  return { status: 'not-implemented', request: values };
}
