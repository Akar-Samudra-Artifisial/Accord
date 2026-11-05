import { createActionHandlers, viewerFromContext, type ActionContext, type ActionPayload } from './handlers';
import { actionServices } from './services';

/** Rovo action entry points (manifest `action` modules); always act for the invoking user. */
export const actionHandlers = createActionHandlers(actionServices);

/** Only teams whose Jira project the invoking user can browse. */
export const listTeamsAction = (_payload?: ActionPayload, context?: ActionContext) => actionHandlers.listTeams(viewerFromContext(context));

export const getTeamCharterAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.getTeamCharter(payload, viewerFromContext(context));

export const getTeamCapacityAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.getTeamCapacity(payload, viewerFromContext(context));

export const getRequestAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.getRequest(payload, viewerFromContext(context));

export const evaluateOptionsAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.evaluateOptions(payload, viewerFromContext(context));

export const listContractsAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.listContracts(payload, viewerFromContext(context));

/**
 * Creates the request only (no Jira change); the deal sheet still needs both team leads (NFR-2).
 * Without `confirm: true` it returns a preview and creates nothing.
 */
export const createDependencyRequestAction = (payload: ActionPayload, context?: ActionContext) =>
  actionHandlers.createDependencyRequest(payload, viewerFromContext(context));
