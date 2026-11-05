import { formatDate, formatDateRange } from '../format/dates';
import { plural } from '../format/text';
import { buildConsequences, deliverableSprintOf, explainOption, type TraceStep } from '../planner';
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
import {
  LINK_CREATED_STEP,
  type Approval,
  type Contract,
  type DependencyRequest,
  type NegotiationStore,
  type RoundRecord,
  type StoredOption,
} from './types';

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
  /** Sprint the planner put the deliverable in (null for options stored before it was recorded). */
  deliverableSprint: { name: string; inJira: boolean } | null;
}

export interface DealSheetView {
  /** `sourceIssueKey` is null (and `title` "Restricted" for a viewer on neither side) when the viewer cannot browse the source issue. */
  request: Omit<DependencyRequest, 'createdBy' | 'sourceIssueKey'> & { sourceIssueKey: string | null };
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
  /** Demo mode is on (Demo tab): one account may approve for both teams. */
  sameApproverAllowed: boolean;
  /** `negotiating`/`approved`/`failed` without progress: a lead may re-queue the job. */
  canRetry: boolean;
  contract: Contract | null;
  /** Latest decision per team, for "Mobile: approved · Payments: pending". */
  sideStatus: Record<Side, SideStatus>;
  /** Jira changes Accord made, once the contract is applied (status `contracted`). */
  appliedChanges: AppliedChange[];
  /** FR-14: what the renegotiated contract agreed and why it is renegotiated; null for a normal request. */
  renegotiationContext: { text: string; issueKeys: string[] } | null;
}

/**
 * "Renegotiation of the contract for PAY-20: agreed Nov 29, 2026, now projected Dec 13, 2026 after 2 critical bugs."
 * Dates come from the replaced contract (its last monitor evaluation); the bug count from round 1's work-ahead summary.
 */
export function renegotiationContext(parent: Contract, criticalBugs: number | null): string {
  const subject = parent.deliverableIssueKey ? `the contract for ${parent.deliverableIssueKey}` : 'the earlier contract';
  const agreed =
    parent.agreedDateMin === parent.agreedDateMax
      ? formatDate(parent.agreedDateMax)
      : formatDateRange(parent.agreedDateMin, parent.agreedDateMax);
  const projected = formatDate(parent.projectedDate, 'beyond the planning horizon');
  const cause = criticalBugs && criticalBugs > 0 ? ` after ${plural(criticalBugs, 'critical bug')}` : '';
  return `Renegotiation of ${subject}: agreed ${agreed}, now projected ${projected}${cause}.`;
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

/** Whether apply-contract created the deliverable and the blocks link, or found them already there. */
export interface AppliedProvenance {
  /** False for a renegotiation, which keeps the deliverable of the contract it replaced. */
  deliverableCreated: boolean;
  /** False when the deliverable already blocked the source issue (no `link-created` step of this contract). */
  linkCreated: boolean;
}

/** Past-tense list of what apply-contract changed (mirrors `previewChanges`). */
export function appliedChanges(
  request: Pick<DependencyRequest, 'title' | 'sourceIssueKey'>,
  providerProjectKey: string,
  option: OptionView,
  contract: Contract,
  provenance: AppliedProvenance = { deliverableCreated: true, linkCreated: true },
  /** Issue keys the viewer may browse; null skips redaction. */
  visible: ReadonlySet<string> | null = null,
): AppliedChange[] {
  if (!contract.deliverableIssueKey) return [];
  const deliverable = contract.deliverableIssueKey;
  const deliverableVisible = !visible || visible.has(deliverable);
  const deliverableKeys = deliverableVisible ? [deliverable] : [];
  // The source issue lives in the requester project: a provider approver may not browse it either.
  const sourceKeys = !visible || visible.has(request.sourceIssueKey) ? [request.sourceIssueKey] : [];
  const hidden = [deliverable, request.sourceIssueKey].filter((key) => visible && !visible.has(key));
  const range = formatDateRange(contract.agreedDateMin, contract.agreedDateMax);
  const due = formatDate(contract.agreedDateMax);
  const changes: AppliedChange[] = [
    {
      kind: 'create-issue',
      text: provenance.deliverableCreated
        ? `Created ${deliverable} "${request.title}" in ${providerProjectKey}, due ${due}.`
        : `Linked existing ${deliverable} "${request.title}" in ${providerProjectKey} and moved its due date to ${due}.`,
      issueKeys: deliverableKeys,
    },
    {
      kind: 'link',
      text: provenance.linkCreated
        ? `Linked ${deliverable} as blocking ${request.sourceIssueKey}.`
        : `${deliverable} already blocked ${request.sourceIssueKey}; no new link.`,
      issueKeys: [...deliverableKeys, ...sourceKeys],
    },
  ];
  const sprint = option.deliverableSprint;
  if (sprint) {
    changes.push({
      kind: sprint.inJira ? 'move-sprint' : 'move-backlog',
      text: sprint.inJira
        ? `Planned ${deliverable} in ${sprint.name}.`
        : `${provenance.deliverableCreated ? 'Kept' : 'Moved'} ${deliverable} ${provenance.deliverableCreated ? 'in' : 'to'} the backlog (planned for ${sprint.name}, which does not exist in Jira yet).`,
      issueKeys: deliverableKeys,
    });
  }
  for (const item of option.shifted) {
    const itemVisible = item.key !== RESTRICTED;
    changes.push({
      kind: item.toBacklog ? 'move-backlog' : 'move-sprint',
      text: item.toBacklog ? `Moved ${item.key} to the backlog.` : `Moved ${item.key} to ${item.toSprint}.`,
      issueKeys: itemVisible ? [item.key] : [],
    });
  }
  changes.push({
    kind: 'comment',
    text: `Commented on ${request.sourceIssueKey} and ${deliverable} with the agreed dates ${range}.`,
    issueKeys: [...sourceKeys, ...deliverableKeys],
  });
  return changes.map((change) => ({ ...change, text: redactKeys(change.text, hidden) }));
}

const RESTRICTED = 'a restricted issue';
/** Shown instead of a request title the viewer may not read (same as the Contracts list). */
export const RESTRICTED_TITLE = 'Restricted';

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
      result = replaceKey(result, key, escapeRegExp(` (${String(step.values.summary)})`));
    }
    result = replaceKey(result, key);
  }
  return result;
}

/**
 * Replaces one whole key (plus `suffix`) with a label that keeps the sentence grammatical:
 * "the existing deliverable (restricted)" after "existing", "contract for a restricted issue" after
 * "contract", "A restricted issue" at the start of a sentence, "a restricted issue" elsewhere.
 */
function replaceKey(text: string, key: string, suffix = ''): string {
  const k = keyPattern(key, suffix).source;
  return text
    // A link to the issue is dropped whole (never left as a broken "/browse/a restricted issue").
    .replace(new RegExp(`(?:https?://[^\\s"'<>()]*)?/browse/${escapeRegExp(key)}(?![0-9])(?:[?#/][^\\s"'<>()]*[^\\s"'<>().,;:!?])?`, 'g'), RESTRICTED)
    .replace(new RegExp(`\\b(?:the )?existing ${k}`, 'g'), 'the existing deliverable (restricted)')
    .replace(new RegExp(`\\bcontract ${k}`, 'g'), 'contract for a restricted issue')
    .replace(new RegExp(`(^|[.!?]\\s+)${k}`, 'g'), '$1A restricted issue')
    .replace(keyPattern(key, suffix), RESTRICTED);
}

/** Replaces whole keys in `hidden` (issues the viewer cannot browse), see `replaceKey`. */
export function redactKeys(text: string, hidden: readonly string[]): string {
  return hidden.reduce((result, key) => replaceKey(result, key), text);
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
  existingDeliverable: string | null,
  /** Hides the source issue/deliverable keys (and title) the viewer may not read. */
  hide: (text: string) => string = (text) => text,
): OptionView {
  const consequences = buildConsequences(option.kind, option.trace);
  const shiftSteps = option.trace.filter((step) => step.step === 'shift');
  const r = (text: string) => hide(redact(text, option.trace, visible));
  const deliverableSprint = deliverableSprintOf(option.trace);
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
        toSprint: isProjectedSprint(item.toSprintId) ? 'the backlog' : step ? String(step.values.toSprint) : item.toSprintId,
        toBacklog: isProjectedSprint(item.toSprintId),
      };
    }),
    rulesUsed: option.rulesUsed,
    consequences: { requester: r(consequences.requester), provider: r(consequences.provider) },
    explanation: r(explainOption(option)),
    trace: option.trace.map((step) => ({ step: step.step, text: r(step.text), sources: redactSources(step.sources, visible) })),
    jiraChanges: previewChanges(request, provider.jiraProjectKey, option, existingDeliverable).map((change) => ({ ...change, text: r(change.text) })),
    deliverableSprint: deliverableSprint ? { name: deliverableSprint.name, inJira: deliverableSprint.inJira } : null,
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
  const [rounds, options, approvals, contract, renegotiation] = await Promise.all([
    store.listRounds(request.id),
    store.listOptions(request.id),
    store.listApprovals(request.id),
    store.getContract(request.id),
    store.getRenegotiation(request.id),
  ]);
  const parentContract = renegotiation ? await store.getContract(renegotiation.parentRequestId) : null;
  const providerRound = round(rounds, 1, 'provider-delegate');
  const criticalBugs = (providerRound?.output as { workAhead?: { criticalBugs?: unknown } } | null)?.workAhead?.criticalBugs;
  const requesterRound = round(rounds, 1, 'requester-delegate');
  const brokerRound = round(rounds, 2, 'broker');
  const rankedIds = (brokerRound?.status === 'done' ? (brokerRound.output as { rankedOptionIds?: number[] }) : null)?.rankedOptionIds;
  const byId = new Map(options.map((option) => [option.id, option]));
  const ranked = rankedIds ? rankedIds.map((id) => byId.get(id)).filter((o): o is StoredOption => Boolean(o)) : [];
  const round1 = rankOptions(options.filter((option) => option.roundId === providerRound?.id));
  const variation = options.filter((option) => requesterRound && option.roundId === requesterRound.id);

  const shiftedKeys = options.flatMap((option) => option.trace.filter((s) => s.step === 'shift' || s.step === 'red-line-kept').map((s) => String(s.values.key)));
  // Deliverables (provider project) and the source issue (requester project) follow the viewer's browse
  // permission too, also for approvers (NFR-3).
  const namedKeys = [request.sourceIssueKey, contract?.deliverableIssueKey, parentContract?.deliverableIssueKey].filter((key): key is string => Boolean(key));
  const visible = await input.visibleKeys([...shiftedKeys, ...namedKeys]);
  const hiddenKeys = visible ? [...new Set(namedKeys)].filter((key) => !visible.has(key)) : [];
  const shownKey = (key: string | null) => (key && hiddenKeys.includes(key) ? null : key);
  // The title may come from the source issue summary: like the Contracts list, a viewer on neither side who
  // cannot browse the source issue does not see it (approvers keep it, they decide on it).
  const titleHidden = input.viewerSides.length === 0 && hiddenKeys.includes(request.sourceIssueKey);
  const hide = (text: string) => {
    const keysHidden = redactKeys(text, hiddenKeys);
    return titleHidden && request.title ? keysHidden.split(request.title).join(RESTRICTED_TITLE) : keysHidden;
  };
  const variationRoundId = requesterRound?.id ?? null;
  const state = approvalState(approvals, request.requesterTeamId, request.providerTeamId);
  const sideOf = (teamId: string): Side => (teamId === request.requesterTeamId ? 'requester' : 'provider');

  const { createdBy, ...ownRequest } = request;
  const publicRequest = {
    ...ownRequest,
    title: titleHidden ? RESTRICTED_TITLE : request.title,
    sourceIssueKey: shownKey(request.sourceIssueKey),
  };
  const existingDeliverable = parentContract?.deliverableIssueKey ?? null;
  const optionViews = ranked.map((option) => toOptionView(option, request, provider, variationRoundId, visible, existingDeliverable, hide));
  const labelOf = (id: number) => optionViews.find((o) => o.id === id)?.label ?? byId.get(id)?.kind ?? null;
  const toSideStatus = (approval: Approval | null): SideStatus => ({
    decision: approval?.decision ?? null,
    optionId: approval?.optionId ?? null,
    optionLabel: approval ? labelOf(approval.optionId) : null,
    byViewer: Boolean(approval && input.viewerAccountId && approval.actorAccountId === input.viewerAccountId),
  });
  const sideStatus: Record<Side, SideStatus> = { requester: toSideStatus(state.requester), provider: toSideStatus(state.provider) };
  const agreedView = contract ? optionViews.find((o) => o.id === contract.optionId) : undefined;
  const applied = request.status === 'contracted' && contract && agreedView;
  const provenance: AppliedProvenance | null = applied
    ? {
        deliverableCreated: !(existingDeliverable && existingDeliverable === contract.deliverableIssueKey),
        linkCreated: await store.hasContractStep(contract.id, LINK_CREATED_STEP),
      }
    : null;
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
    }).map((line) => ({
      ...line,
      text: hide([...round1, ...variation].reduce((text, o) => redact(text, o.trace, visible), line.text)),
    })),
    rounds: rounds.map((item) => ({ roundNo: item.roundNo, role: item.role, status: item.status, error: item.error === null ? null : hide(item.error) })),
    approvals: approvals.map((approval) => ({
      side: sideOf(approval.teamId),
      decision: approval.decision,
      optionId: approval.optionId,
      reason: approval.reason === null ? null : hide(approval.reason),
    })),
    agreedOptionId: state.agreedOptionId,
    canDecideAs: request.status === 'awaiting-approval' ? openSides(input.viewerSides, sideStatus) : [],
    sameApproverAllowed: input.sameApproverAllowed,
    canRetry: input.canRetry,
    contract: contract ? { ...contract, deliverableIssueKey: shownKey(contract.deliverableIssueKey) } : null,
    sideStatus,
    appliedChanges:
      contract && agreedView && provenance
        ? appliedChanges(request, provider.jiraProjectKey, agreedView, contract, provenance, visible).map((change) => ({ ...change, text: hide(change.text) }))
        : [],
    renegotiationContext: parentContract
      ? {
          text: hide(renegotiationContext(parentContract, typeof criticalBugs === 'number' ? criticalBugs : null)),
          issueKeys: [shownKey(parentContract.deliverableIssueKey)].filter((key): key is string => Boolean(key)),
        }
      : null,
  };
}

export interface RequestSummary {
  id: string;
  title: string;
  status: DependencyRequest['status'];
  /** Null when the viewer cannot browse the source issue. */
  sourceIssueKey: string | null;
  neededBy: string;
  requester: string;
  provider: string;
  /** Sides the viewer still has to decide for. */
  pendingFor: Side[];
  /** Opened by Accord for an at-risk contract (FR-14). */
  renegotiation: boolean;
  /** Display names the request was escalated to (FR-15); empty when not escalated. */
  escalatedTo: string[];
}

export interface SummaryExtras {
  renegotiation?: boolean;
  escalatedTo?: readonly string[];
}

export function summarize(
  request: DependencyRequest,
  teams: ReadonlyMap<string, Team>,
  viewerSides: Side[],
  approvals: readonly Approval[],
  extras: SummaryExtras = {},
  /** Whether the viewer may browse the source issue (approvers keep the title, not the key). */
  sourceVisible = true,
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
    sourceIssueKey: sourceVisible ? request.sourceIssueKey : null,
    neededBy: request.neededBy,
    requester: teams.get(request.requesterTeamId)?.name ?? request.requesterTeamId,
    provider: teams.get(request.providerTeamId)?.name ?? request.providerTeamId,
    pendingFor,
    renegotiation: extras.renegotiation ?? false,
    escalatedTo: [...(extras.escalatedTo ?? [])],
  };
}
