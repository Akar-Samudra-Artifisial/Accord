import { buildConsequences, explainOption, type TraceStep } from '../planner';
import type { Team } from '../teams/repository';
import {
  approvalState,
  buildTranscript,
  isProjectedSprint,
  KIND_LABEL,
  previewChanges,
  rankOptions,
  type JiraChange,
  type Side,
  type TranscriptLine,
} from './delegates';
import { storedDecision } from './orchestrator';
import type { Approval, Contract, DependencyRequest, NegotiationStore, RoundRecord, StoredOption } from './types';

export interface OptionView {
  id: number;
  kind: StoredOption['kind'];
  label: string;
  dateRange: StoredOption['dateRange'];
  meetsNeed: boolean;
  recommended: boolean;
  fromVariation: boolean;
  shifted: Array<{ key: string; toSprint: string; toBacklog: boolean }>;
  rulesUsed: string[];
  consequences: { requester: string; provider: string };
  explanation: string;
  trace: Array<{ step: string; text: string; sources: TraceStep['sources'] }>;
  jiraChanges: JiraChange[];
}

export interface DealSheetView {
  request: Omit<DependencyRequest, 'createdBy'>;
  requester: { teamKey: string; name: string };
  provider: { teamKey: string; name: string; projectKey: string };
  options: OptionView[];
  transcript: TranscriptLine[];
  rounds: Array<{ roundNo: number; role: string; status: string; error: string | null }>;
  /** No account ids: the UI names the deciding team only. */
  approvals: Array<{ side: Side; decision: Approval['decision']; optionId: number; reason: string | null }>;
  agreedOptionId: number | null;
  /** Sides the current user may decide for (one person can be lead of both teams). */
  canDecideAs: Side[];
  /** Demo switch ACCORD_DEMO_ALLOW_SAME_APPROVER is on: one account may approve for both teams. */
  sameApproverAllowed: boolean;
  /** `negotiating`/`approved`/`failed` without progress: a lead may re-queue the job. */
  canRetry: boolean;
  contract: Contract | null;
  /** Latest decision per team, for "Mobile: approved · Payments: pending". */
  sideStatus: Record<Side, SideStatus>;
  /** Jira changes Accord made, once the contract is applied (status `contracted`). */
  appliedChanges: AppliedChange[];
}

export interface SideStatus {
  decision: 'approve' | 'reject' | null;
  optionId: number | null;
  optionLabel: string | null;
  /** The viewer made this decision (no account ids leave the backend). */
  byViewer: boolean;
}

export interface AppliedChange {
  kind: JiraChange['kind'];
  text: string;
  /** Issue keys mentioned in the change, linked in the UI. */
  issueKeys: string[];
}

/** Past-tense list of what apply-contract changed (mirrors `previewChanges`). */
export function appliedChanges(
  request: Pick<DependencyRequest, 'title' | 'sourceIssueKey'>,
  providerProjectKey: string,
  option: OptionView,
  contract: Contract,
): AppliedChange[] {
  const deliverable = contract.deliverableIssueKey;
  if (!deliverable) return [];
  const range = `${contract.agreedDateMin} to ${contract.agreedDateMax}`;
  const changes: AppliedChange[] = [
    { kind: 'create-issue', text: `Created ${deliverable} "${request.title}" in ${providerProjectKey}, due ${contract.agreedDateMax}.`, issueKeys: [deliverable] },
    { kind: 'link', text: `Linked ${deliverable} as blocking ${request.sourceIssueKey}.`, issueKeys: [deliverable, request.sourceIssueKey] },
  ];
  for (const item of option.shifted) {
    const visible = item.key !== RESTRICTED;
    changes.push({
      kind: item.toBacklog ? 'move-backlog' : 'move-sprint',
      text: item.toBacklog ? `Moved ${item.key} to the backlog.` : `Moved ${item.key} to ${item.toSprint}.`,
      issueKeys: visible ? [item.key] : [],
    });
  }
  changes.push({
    kind: 'comment',
    text: `Commented on ${request.sourceIssueKey} and ${deliverable} with the agreed dates ${range}.`,
    issueKeys: [request.sourceIssueKey, deliverable],
  });
  return changes;
}

const RESTRICTED = 'a restricted issue';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the whole key only: PAY-1 never matches inside PAY-11 or XPAY-1. */
const keyPattern = (key: string, suffix = '') =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(key)}(?![0-9])${suffix}`, 'g');

/** Hides keys/summaries of issues the viewer cannot browse (NFR-3). */
export function redact(text: string, trace: readonly TraceStep[], visible: ReadonlySet<string> | null): string {
  if (!visible) return text;
  let result = text;
  for (const step of trace) {
    if (step.step !== 'shift' && step.step !== 'red-line-kept') continue;
    const key = String(step.values.key);
    if (visible.has(key)) continue;
    if (step.values.summary !== undefined) {
      result = result.replace(keyPattern(key, escapeRegExp(` (${String(step.values.summary)})`)), RESTRICTED);
    }
    result = result.replace(keyPattern(key), RESTRICTED);
  }
  return result;
}

/** Issue sources of restricted issues lose their key as well. */
export function redactSources(sources: TraceStep['sources'], visible: ReadonlySet<string> | null): TraceStep['sources'] {
  if (!visible) return sources;
  return sources.map((source) => (source.type === 'issue' && !visible.has(source.ref) ? { ...source, ref: RESTRICTED } : source));
}

function toOptionView(
  option: StoredOption,
  request: DependencyRequest,
  provider: Team,
  variationRoundId: number | null,
  visible: ReadonlySet<string> | null,
): OptionView {
  const consequences = buildConsequences(option.kind, option.trace);
  const shiftSteps = option.trace.filter((step) => step.step === 'shift');
  const r = (text: string) => redact(text, option.trace, visible);
  return {
    id: option.id,
    kind: option.kind,
    label: KIND_LABEL[option.kind],
    dateRange: option.dateRange,
    meetsNeed: option.meetsNeed,
    recommended: option.recommended,
    fromVariation: variationRoundId !== null && option.roundId === variationRoundId,
    shifted: option.shifted.map((item) => {
      const step = shiftSteps.find((candidate) => candidate.values.key === item.key);
      return {
        key: visible && !visible.has(item.key) ? RESTRICTED : item.key,
        toSprint: step ? String(step.values.toSprint) : item.toSprintId,
        toBacklog: isProjectedSprint(item.toSprintId),
      };
    }),
    rulesUsed: option.rulesUsed,
    consequences: { requester: r(consequences.requester), provider: r(consequences.provider) },
    explanation: r(explainOption(option)),
    trace: option.trace.map((step) => ({ step: step.step, text: r(step.text), sources: redactSources(step.sources, visible) })),
    jiraChanges: previewChanges(request, provider.jiraProjectKey, option).map((change) => ({ ...change, text: r(change.text) })),
  };
}

function round(rounds: readonly RoundRecord[], roundNo: number, role: string): RoundRecord | undefined {
  return rounds.find((item) => item.roundNo === roundNo && item.role === role);
}

export interface DealSheetInput {
  store: NegotiationStore;
  request: DependencyRequest;
  requester: Team;
  provider: Team;
  viewerSides: Side[];
  /** Issue keys the viewer may browse; null skips redaction. */
  visibleKeys: (keys: string[]) => Promise<ReadonlySet<string> | null>;
  sameApproverAllowed: boolean;
  canRetry: boolean;
  /** Used only to mark the viewer's own decisions; never returned. */
  viewerAccountId?: string;
}

/**
 * Sides the viewer may still decide for. A side that already approved is done, unless the two
 * teams approved different options: then both may switch to realign.
 */
export function openSides(viewerSides: readonly Side[], status: Record<Side, SideStatus>): Side[] {
  const { requester, provider } = status;
  const disagree =
    requester.decision === 'approve' && provider.decision === 'approve' && requester.optionId !== provider.optionId;
  return viewerSides.filter((side) => status[side].decision === null || disagree);
}

export async function buildDealSheet(input: DealSheetInput): Promise<DealSheetView> {
  const { store, request, requester, provider } = input;
  const [rounds, options, approvals, contract] = await Promise.all([
    store.listRounds(request.id),
    store.listOptions(request.id),
    store.listApprovals(request.id),
    store.getContract(request.id),
  ]);
  const providerRound = round(rounds, 1, 'provider-delegate');
  const requesterRound = round(rounds, 1, 'requester-delegate');
  const brokerRound = round(rounds, 2, 'broker');
  const rankedIds = (brokerRound?.status === 'done' ? (brokerRound.output as { rankedOptionIds?: number[] }) : null)?.rankedOptionIds;
  const byId = new Map(options.map((option) => [option.id, option]));
  const ranked = rankedIds ? rankedIds.map((id) => byId.get(id)).filter((o): o is StoredOption => Boolean(o)) : [];
  const round1 = rankOptions(options.filter((option) => option.roundId === providerRound?.id));
  const variation = options.filter((option) => requesterRound && option.roundId === requesterRound.id);

  const shiftedKeys = options.flatMap((option) => option.trace.filter((s) => s.step === 'shift' || s.step === 'red-line-kept').map((s) => String(s.values.key)));
  const visible = await input.visibleKeys(shiftedKeys);
  const variationRoundId = requesterRound?.id ?? null;
  const state = approvalState(approvals, request.requesterTeamId, request.providerTeamId);
  const sideOf = (teamId: string): Side => (teamId === request.requesterTeamId ? 'requester' : 'provider');

  const { createdBy, ...publicRequest } = request;
  const optionViews = ranked.map((option) => toOptionView(option, request, provider, variationRoundId, visible));
  const labelOf = (id: number) => optionViews.find((o) => o.id === id)?.label ?? byId.get(id)?.kind ?? null;
  const toSideStatus = (approval: Approval | null): SideStatus => ({
    decision: approval?.decision ?? null,
    optionId: approval?.optionId ?? null,
    optionLabel: approval ? labelOf(approval.optionId) : null,
    byViewer: Boolean(approval && input.viewerAccountId && approval.actorAccountId === input.viewerAccountId),
  });
  const sideStatus: Record<Side, SideStatus> = { requester: toSideStatus(state.requester), provider: toSideStatus(state.provider) };
  const agreedView = contract ? optionViews.find((o) => o.id === contract.optionId) : undefined;
  return {
    request: publicRequest,
    requester: { teamKey: requester.teamKey, name: requester.name },
    provider: { teamKey: provider.teamKey, name: provider.name, projectKey: provider.jiraProjectKey },
    options: optionViews,
    transcript: buildTranscript({
      requesterName: requester.name,
      providerName: provider.name,
      round1,
      variation,
      decision: requesterRound?.status === 'done' ? storedDecision(requesterRound.output) : null,
      ranked,
    }).map((line) => ({ ...line, text: [...round1, ...variation].reduce((text, o) => redact(text, o.trace, visible), line.text) })),
    rounds: rounds.map((item) => ({ roundNo: item.roundNo, role: item.role, status: item.status, error: item.error })),
    approvals: approvals.map((approval) => ({
      side: sideOf(approval.teamId),
      decision: approval.decision,
      optionId: approval.optionId,
      reason: approval.reason,
    })),
    agreedOptionId: state.agreedOptionId,
    canDecideAs: request.status === 'awaiting-approval' ? openSides(input.viewerSides, sideStatus) : [],
    sameApproverAllowed: input.sameApproverAllowed,
    canRetry: input.canRetry,
    contract,
    sideStatus,
    appliedChanges:
      request.status === 'contracted' && contract && agreedView
        ? appliedChanges(request, provider.jiraProjectKey, agreedView, contract)
        : [],
  };
}

export interface RequestSummary {
  id: string;
  title: string;
  status: DependencyRequest['status'];
  sourceIssueKey: string;
  neededBy: string;
  requester: string;
  provider: string;
  /** Sides the viewer still has to decide for. */
  pendingFor: Side[];
}

export function summarize(
  request: DependencyRequest,
  teams: ReadonlyMap<string, Team>,
  viewerSides: Side[],
  approvals: readonly Approval[],
): RequestSummary {
  const state = approvalState(approvals, request.requesterTeamId, request.providerTeamId);
  const pendingFor =
    request.status === 'awaiting-approval'
      ? viewerSides.filter((side) => !(side === 'requester' ? state.requester : state.provider))
      : [];
  return {
    id: request.id,
    title: request.title,
    status: request.status,
    sourceIssueKey: request.sourceIssueKey,
    neededBy: request.neededBy,
    requester: teams.get(request.requesterTeamId)?.name ?? request.requesterTeamId,
    provider: teams.get(request.providerTeamId)?.name ?? request.providerTeamId,
    pendingFor,
  };
}
