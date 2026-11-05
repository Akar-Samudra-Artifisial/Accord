import { formatDate, formatDateRange } from '../format/dates';
import { buildConsequences, renderTemplate } from '../planner';
import { mergeTraceValues } from '../planner/explain';
import type { OptionKind, PlannerVariation, TraceStep } from '../planner';
import type { Approval, DependencyRequest, StoredOption } from './types';

/**
 * Pure, deterministic negotiation rules (PRD "Protokol negosiasi"). No Forge
 * imports: everything here is unit tested. Narrative text is rendered only from
 * planner trace values (NFR-1).
 */

/** Days earlier the requester delegate asks for, PRD example "two days earlier". */
export const VARIATION_DAYS = 2;
export const MAX_DEAL_SHEET_OPTIONS = 4;

export type RequesterDecision =
  | { action: 'accept'; reason: 'meets-need' | 'no-minimum' }
  | { action: 'request-variation'; variation: PlannerVariation };

/**
 * Round 1, requester delegate: when no option meets the need and the requester
 * marked a minimum useful part, ask once for that part `VARIATION_DAYS` earlier.
 */
export function requesterDecision(
  request: Pick<DependencyRequest, 'minSize'>,
  options: ReadonlyArray<Pick<StoredOption, 'meetsNeed'>>,
): RequesterDecision {
  if (options.some((option) => option.meetsNeed)) return { action: 'accept', reason: 'meets-need' };
  if (request.minSize === null) return { action: 'accept', reason: 'no-minimum' };
  return { action: 'request-variation', variation: { kind: 'earlier-min', days: VARIATION_DAYS } };
}

const KIND_ORDER: Readonly<Record<OptionKind, number>> = {
  'on-time': 0,
  'on-time-with-shift': 1,
  partial: 2,
  later: 3,
  reject: 4,
};

export const KIND_LABEL: Readonly<Record<OptionKind, string>> = {
  'on-time': 'On time',
  'on-time-with-shift': 'On time with a shift',
  partial: 'Minimum part first',
  later: 'Later date',
  reject: 'Decline',
};

function dedupeKey(option: StoredOption): string {
  const partial = mergeTraceValues(option.trace);
  return [
    option.kind === 'reject' ? 'reject' : '',
    option.meetsNeed,
    option.dateRange.min,
    option.dateRange.max,
    option.shifted.map((item) => `${item.key}>${item.toSprintId}`).join(','),
    option.kind === 'partial' ? `${partial.remainderSize}@${partial.remainderDateMax}` : '',
  ].join('|');
}

/**
 * Round 2, broker: same ordering rule as the planner (PRD "Pembentukan opsi"):
 * declines last, options meeting the need first, then lower shift cost, earlier
 * date; ties keep the earlier-stored option. Duplicates of round 1 offers from
 * the variation are dropped. At most four options.
 */
export function rankOptions(options: readonly StoredOption[]): StoredOption[] {
  const sorted = [...options].sort(
    (a, b) =>
      Number(a.kind === 'reject') - Number(b.kind === 'reject') ||
      Number(b.meetsNeed) - Number(a.meetsNeed) ||
      a.shiftCost - b.shiftCost ||
      (a.dateRange.max < b.dateRange.max ? -1 : a.dateRange.max > b.dateRange.max ? 1 : 0) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.id - b.id,
  );
  const seen = new Set<string>();
  return sorted
    .filter((option) => {
      const key = dedupeKey(option);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DEAL_SHEET_OPTIONS);
}

export interface TranscriptLine {
  round: 1 | 2;
  speaker: string;
  text: string;
}

function traceValue(trace: readonly TraceStep[], step: string, name: string): string | number | undefined {
  return trace.find((item) => item.step === step)?.values[name];
}

function offerText(option: StoredOption): string {
  const consequences = buildConsequences(option.kind, option.trace);
  return `${KIND_LABEL[option.kind]}. For the requesting team: ${consequences.requester} For the providing team: ${consequences.provider}`;
}

export interface TranscriptInput {
  requesterName: string;
  providerName: string;
  round1: readonly StoredOption[];
  variation: readonly StoredOption[];
  /** Requester delegate decision as stored in round 1. */
  decision: RequesterDecision | null;
  /** Broker ranking; empty until round 2 is done. */
  ranked: readonly StoredOption[];
}

/**
 * Template-based negotiation transcript. Every number comes from an option's
 * planner trace; nothing is computed here.
 */
export function buildTranscript(input: TranscriptInput): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const provider = `${input.providerName} Delegate`;
  const requester = `${input.requesterName} Delegate`;
  for (const option of input.round1) {
    lines.push({ round: 1, speaker: provider, text: `Offers: ${offerText(option)}` });
  }
  const first = input.round1[0];
  const neededBy = first ? traceValue(first.trace, 'requested', 'neededBy') : undefined;
  if (input.decision && neededBy !== undefined) {
    if (input.decision.action === 'accept') {
      const template =
        input.decision.reason === 'meets-need'
          ? 'Checks the offers against the need date {neededBy}. At least one offer meets it, so no variation is requested.'
          : 'No offer meets the need date {neededBy} and no minimum part was marked, so the offers go to the broker unchanged.';
      lines.push({ round: 1, speaker: requester, text: renderTemplate(template, { neededBy }) });
    } else {
      const withVariation = input.variation[0];
      const variationStep = withVariation?.trace.find((item) => item.step === 'variation');
      lines.push({
        round: 1,
        speaker: requester,
        text: variationStep
          ? renderTemplate(
              'No offer meets the need date {neededBy}. Asks whether the minimum part can arrive {days|day} earlier, by {neededByMin}.',
              { neededBy, ...variationStep.values },
            )
          : renderTemplate('No offer meets the need date {neededBy}. Asks for the minimum part earlier.', { neededBy }),
      });
      if (input.variation.length === 0) {
        lines.push({ round: 1, speaker: provider, text: 'The planner found no additional option for the variation.' });
      }
      for (const option of input.variation) {
        lines.push({ round: 1, speaker: provider, text: `Recalculated: ${offerText(option)}` });
      }
    }
  }
  const [recommended, ...alternatives] = input.ranked;
  if (recommended) {
    const alternativesText = alternatives.length
      ? ` Alternatives: ${alternatives.map((option) => KIND_LABEL[option.kind]).join('; ')}.`
      : ' There are no alternatives.';
    lines.push({
      round: 2,
      speaker: 'Accord Broker',
      text: `Recommends: ${offerText(recommended)}${alternativesText} Both team leads decide; Accord never approves on a team's behalf.`,
    });
  }
  return lines;
}

export interface JiraChange {
  kind: 'create-issue' | 'link' | 'move-sprint' | 'move-backlog' | 'comment';
  text: string;
}

export function isProjectedSprint(sprintId: string): boolean {
  return sprintId.startsWith('projected-');
}

/** Everything apply-contract would change in Jira, shown before approval (PRD "Tidak ada kejutan"). */
export function previewChanges(
  request: Pick<DependencyRequest, 'title' | 'sourceIssueKey'>,
  providerProjectKey: string,
  option: StoredOption,
  /** Renegotiation: the deliverable of the replaced contract, which is kept instead of creating a new issue. */
  existingDeliverable: string | null = null,
): JiraChange[] {
  if (option.kind === 'reject') return [];
  const changes: JiraChange[] = existingDeliverable
    ? [
        {
          kind: 'create-issue',
          text: `Keep the existing ${existingDeliverable} and move its due date to ${formatDate(option.dateRange.max)}.`,
        },
        { kind: 'link', text: `Link ${existingDeliverable} as blocking ${request.sourceIssueKey} unless it already blocks it.` },
      ]
    : [
        {
          kind: 'create-issue',
          text: `Create a Story "${request.title}" in project ${providerProjectKey}, due ${formatDate(option.dateRange.max)}, labelled accord.`,
        },
        { kind: 'link', text: `Link the new issue as blocking ${request.sourceIssueKey}.` },
      ];
  const shiftSteps = option.trace.filter((step) => step.step === 'shift');
  for (const item of option.shifted) {
    const step = shiftSteps.find((candidate) => candidate.values.key === item.key);
    const target = step ? String(step.values.toSprint) : item.toSprintId;
    changes.push(
      isProjectedSprint(item.toSprintId)
        ? { kind: 'move-backlog', text: `Move ${item.key} to the backlog (${target} does not exist in Jira yet).` }
        : { kind: 'move-sprint', text: `Move ${item.key} to ${target}.` },
    );
  }
  changes.push({
    kind: 'comment',
    text: `Comment on ${request.sourceIssueKey} and on ${existingDeliverable ?? 'the new issue'} with the agreed dates ${formatDateRange(option.dateRange.min, option.dateRange.max)}.`,
  });
  return changes;
}

export type Side = 'requester' | 'provider';

export interface ApprovalState {
  requester: Approval | null;
  provider: Approval | null;
  rejected: Approval | null;
  /** Set when both sides' latest decision approves the same option. */
  agreedOptionId: number | null;
}

/** Latest decision per team wins; one rejection ends the negotiation. */
export function approvalState(
  approvals: readonly Approval[],
  requesterTeamId: string,
  providerTeamId: string,
): ApprovalState {
  const latest = (teamId: string) =>
    [...approvals].filter((approval) => approval.teamId === teamId).sort((a, b) => a.id - b.id).pop() ?? null;
  const requester = latest(requesterTeamId);
  const provider = latest(providerTeamId);
  const rejected = [requester, provider].find((approval) => approval?.decision === 'reject') ?? null;
  const agreed =
    !rejected &&
    requester?.decision === 'approve' &&
    provider?.decision === 'approve' &&
    requester.optionId === provider.optionId
      ? requester.optionId
      : null;
  return { requester, provider, rejected, agreedOptionId: agreed };
}
