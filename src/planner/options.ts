import {
  COST_WEIGHT,
  SIZE_ISSUES,
  compareShiftCandidates,
  describeRule,
  firstMatchingRule,
  itemSize,
} from './cost';
import { addDays, daysBetween, parseIsoDate } from './dates';
import { buildConsequences, makeStep } from './explain';
import type {
  DateRange,
  IsoDate,
  OptionKind,
  PlannerInput,
  PlannerOption,
  PlannerResult,
  ShiftedItem,
  Sprint,
  TraceSource,
  TraceStep,
  WorkItem,
} from './types';

export const MAX_HORIZON_SPRINTS = 12;
export const MAX_OPTIONS = 4;
const DEFAULT_SPRINT_DAYS = 14;

const KIND_ORDER: Readonly<Record<OptionKind, number>> = {
  'on-time': 0,
  'on-time-with-shift': 1,
  partial: 2,
  later: 3,
  reject: 4,
};

interface Slot {
  sprint: Sprint;
  items: WorkItem[];
}

interface Context {
  input: PlannerInput;
  slots: Slot[];
  committed: number[];
  requested: number;
  neededBy: IsoDate;
  capP: number;
  capR: number;
  baseTrace: TraceStep[];
  shareRule: string;
}

type Draft = Omit<PlannerOption, 'recommended' | 'consequences'>;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateInput(input: PlannerInput): void {
  const { charter, capacity, request } = input;
  parseIsoDate(input.today);
  parseIsoDate(request.neededBy);
  if (!(charter.maxExternalShare >= 0 && charter.maxExternalShare <= 1)) {
    throw new Error(`Invalid charter maxExternalShare ${charter.maxExternalShare}: expected 0..1`);
  }
  if (!(capacity.pessimistic >= 0 && capacity.realistic >= 0)) {
    throw new Error('Invalid capacity: pessimistic and realistic must be non-negative');
  }
  if (request.minSize !== undefined && !(Number.isInteger(request.minSize) && request.minSize >= 1)) {
    throw new Error(`Invalid request minSize ${request.minSize}: expected a positive integer`);
  }
  if (input.variation && !(Number.isInteger(input.variation.days) && input.variation.days > 0)) {
    throw new Error(`Invalid variation days ${input.variation.days}: expected a positive integer`);
  }
  for (const sprint of input.sprints) {
    if (parseIsoDate(sprint.endDate) < parseIsoDate(sprint.startDate)) {
      throw new Error(`Invalid sprint ${sprint.id}: endDate is before startDate`);
    }
  }
}

/** Active and future sprints, extended with projected sprints of equal length. */
export function buildHorizon(sprints: readonly Sprint[], today: IsoDate): Sprint[] {
  const real = sprints
    .filter((s) => s.state !== 'closed' && s.endDate >= today)
    .sort((a, b) => compareStrings(a.startDate, b.startDate) || compareStrings(a.id, b.id))
    .slice(0, MAX_HORIZON_SPRINTS);
  const last = real[real.length - 1];
  const lengthDays = last ? daysBetween(last.startDate, last.endDate) : DEFAULT_SPRINT_DAYS - 1;
  const horizon = [...real];
  let previousEnd = last ? last.endDate : addDays(today, -1);
  let projected = 0;
  while (horizon.length < MAX_HORIZON_SPRINTS) {
    projected += 1;
    const startDate = addDays(previousEnd, 1);
    const endDate = addDays(startDate, lengthDays);
    horizon.push({
      id: `projected-${projected}`,
      name: `Projected sprint ${projected}`,
      startDate,
      endDate,
      state: 'future',
    });
    previousEnd = endDate;
  }
  return horizon;
}

function assignCommitments(horizon: readonly Sprint[], commitments: readonly WorkItem[], neededBy: IsoDate): Slot[] {
  const slots: Slot[] = horizon.map((sprint) => ({ sprint, items: [] }));
  const indexById = new Map(horizon.map((sprint, index) => [sprint.id, index]));
  const sorted = [...commitments].sort((a, b) => compareStrings(a.key, b.key));
  for (const item of sorted) {
    const index = item.sprintId !== undefined ? indexById.get(item.sprintId) : undefined;
    if (index !== undefined) {
      slots[index].items.push(item);
    } else if (item.dueDate !== undefined && item.dueDate < neededBy) {
      // Unscheduled work due before the needed-by date competes for the first sprint.
      slots[0].items.push(item);
    }
  }
  return slots;
}

function usable(base: number, cap: number, committed: number): number {
  return Math.min(Math.max(0, base - committed), cap);
}

function eligibleCount(slots: readonly Slot[], date: IsoDate): number {
  return slots.filter((slot) => slot.sprint.endDate <= date).length;
}

/** Index of the first slot where cumulative usable room reaches `amount`, or -1. */
function reachIndex(committed: readonly number[], base: number, cap: number, amount: number, limit: number): number {
  let total = 0;
  for (let i = 0; i < limit; i += 1) {
    total += usable(base, cap, committed[i]);
    if (total >= amount) return i;
  }
  return -1;
}

function sumUsable(committed: readonly number[], base: number, cap: number, limit: number): number {
  let total = 0;
  for (let i = 0; i < limit; i += 1) total += usable(base, cap, committed[i]);
  return total;
}

function rangeFor(ctx: Context, committed: readonly number[], amount: number, limit: number): DateRange | undefined {
  const { capacity } = ctx.input;
  const pIndex = reachIndex(committed, capacity.pessimistic, ctx.capP, amount, limit);
  if (pIndex < 0) return undefined;
  const rIndex = reachIndex(committed, capacity.realistic, ctx.capR, amount, limit);
  const minIndex = rIndex >= 0 && rIndex < pIndex ? rIndex : pIndex;
  return { min: ctx.slots[minIndex].sprint.endDate, max: ctx.slots[pIndex].sprint.endDate };
}

function sprintSources(slots: readonly Slot[], limit: number): TraceSource[] {
  return slots.slice(0, limit).map((slot) => ({ type: 'sprint', ref: slot.sprint.id }));
}

function draft(kind: OptionKind, fields: Partial<Draft> & Pick<Draft, 'dateRange' | 'trace' | 'meetsNeed'>): Draft {
  return { id: kind, kind, shifted: [], rulesUsed: [], shiftCost: 0, ...fields };
}

function onTimeOption(ctx: Context, limit: number): Draft | undefined {
  const range = rangeFor(ctx, ctx.committed, ctx.requested, limit);
  if (!range) return undefined;
  const step = makeStep(
    'on-time',
    { requested: ctx.requested, dateMin: range.min, dateMax: range.max },
    sprintSources(ctx.slots, limit),
  );
  return draft('on-time', {
    dateRange: range,
    meetsNeed: true,
    rulesUsed: [ctx.shareRule],
    trace: [...ctx.baseTrace, step],
  });
}

interface ShiftOutcome {
  option?: Draft;
  redLineBlocked: boolean;
  redLineRules: string[];
}

function shiftOption(ctx: Context, limit: number): ShiftOutcome {
  const { charter, capacity } = ctx.input;
  const candidates: { item: WorkItem; slotIndex: number; rule: string }[] = [];
  const kept: { item: WorkItem; slotIndex: number; rule: string }[] = [];
  for (let i = 0; i < limit; i += 1) {
    for (const item of ctx.slots[i].items) {
      const shiftRule = firstMatchingRule(item, charter.shiftable);
      if (!shiftRule) continue;
      const redLine = firstMatchingRule(item, charter.redLines);
      if (redLine) {
        kept.push({ item, slotIndex: i, rule: describeRule(redLine) });
      } else {
        candidates.push({ item, slotIndex: i, rule: describeRule(shiftRule) });
      }
    }
  }
  candidates.sort((a, b) => compareShiftCandidates(a.item, b.item));
  kept.sort((a, b) => compareStrings(a.item.key, b.item.key));
  const redLineRules = [...new Set(kept.map((k) => `Red line: ${k.rule}`))];

  const committed = [...ctx.committed];
  const moves: { item: WorkItem; from: number; to: number; rule: string }[] = [];
  const base = capacity.pessimistic;
  for (const candidate of candidates) {
    if (sumUsable(committed, base, ctx.capP, limit) >= ctx.requested) break;
    const size = itemSize(candidate.item);
    const from = candidate.slotIndex;
    if (usable(base, ctx.capP, committed[from] - size) <= usable(base, ctx.capP, committed[from])) continue;
    let to = -1;
    for (let t = limit; t < ctx.slots.length; t += 1) {
      if (base - committed[t] >= size) {
        to = t;
        break;
      }
    }
    if (to < 0) continue;
    committed[from] -= size;
    committed[to] += size;
    moves.push({ item: candidate.item, from, to, rule: candidate.rule });
  }

  const redLineBlocked = kept.length > 0;
  if (moves.length === 0 || sumUsable(committed, base, ctx.capP, limit) < ctx.requested) {
    return { redLineBlocked, redLineRules };
  }
  const range = rangeFor(ctx, committed, ctx.requested, limit);
  if (!range) return { redLineBlocked, redLineRules };

  const shifted: ShiftedItem[] = moves.map((m) => ({
    key: m.item.key,
    costClass: m.item.costClass,
    toSprintId: ctx.slots[m.to].sprint.id,
  }));
  const shiftCost = moves.reduce((sum, m) => sum + COST_WEIGHT[m.item.costClass], 0);
  const trace: TraceStep[] = [...ctx.baseTrace];
  for (const m of moves) {
    trace.push(
      makeStep(
        'shift',
        {
          key: m.item.key,
          summary: m.item.summary,
          fromSprint: ctx.slots[m.from].sprint.name,
          toSprint: ctx.slots[m.to].sprint.name,
        },
        [
          { type: 'issue', ref: m.item.key },
          { type: 'sprint', ref: ctx.slots[m.to].sprint.id },
          { type: 'charter', ref: 'shiftable' },
        ],
      ),
    );
  }
  for (const k of kept) {
    trace.push(makeStep('red-line-kept', { key: k.item.key, rule: k.rule }, [
      { type: 'issue', ref: k.item.key },
      { type: 'charter', ref: 'redLines' },
    ]));
  }
  trace.push(
    makeStep('shift-total', {
      shiftedCount: moves.length,
      shiftedKeys: moves.map((m) => m.item.key).join(', '),
      shiftCost,
      requested: ctx.requested,
      dateMin: range.min,
      dateMax: range.max,
    }),
  );
  const rulesUsed = [ctx.shareRule, ...new Set(moves.map((m) => `Shiftable: ${m.rule}`)), ...redLineRules];
  return {
    redLineBlocked,
    redLineRules,
    option: draft('on-time-with-shift', { dateRange: range, meetsNeed: true, shifted, shiftCost, rulesUsed, trace }),
  };
}

function laterOption(ctx: Context): Draft | undefined {
  const range = rangeFor(ctx, ctx.committed, ctx.requested, ctx.slots.length);
  if (!range) return undefined;
  const step = makeStep(
    'later',
    { dateMin: range.min, dateMax: range.max, daysLate: daysBetween(ctx.neededBy, range.max), neededBy: ctx.neededBy },
    sprintSources(ctx.slots, ctx.slots.length),
  );
  return draft('later', {
    dateRange: range,
    meetsNeed: range.max <= ctx.neededBy,
    rulesUsed: [ctx.shareRule],
    trace: [...ctx.baseTrace, step],
  });
}

function partialOption(ctx: Context, minSize: number, neededByMin: IsoDate): Draft | undefined {
  const minLimit = eligibleCount(ctx.slots, neededByMin);
  const minRange = rangeFor(ctx, ctx.committed, minSize, minLimit);
  const fullRange = rangeFor(ctx, ctx.committed, ctx.requested, ctx.slots.length);
  if (!minRange || !fullRange) return undefined;
  const remainderSize = ctx.requested - minSize;
  const step = makeStep(
    'partial',
    { minSize, minDateMax: minRange.max, remainderSize, remainderDateMax: fullRange.max },
    sprintSources(ctx.slots, minLimit),
  );
  return draft('partial', {
    dateRange: minRange,
    meetsNeed: true,
    rulesUsed: [ctx.shareRule, 'Minimum useful part marked by the requester'],
    trace: [...ctx.baseTrace, step],
    remainder: { size: remainderSize, dateRange: fullRange },
  });
}

function rejectOption(ctx: Context, reason: 'share' | 'red-line' | 'horizon', redLineRules: string[], limit: number): Draft {
  const { charter } = ctx.input;
  const sharePercent = Math.round(charter.maxExternalShare * 100);
  let step: TraceStep;
  let rejectReason: string;
  let rulesUsed: string[];
  if (reason === 'share') {
    rejectReason = `at most ${sharePercent}% of pessimistic capacity per sprint goes to other teams`;
    rulesUsed = [ctx.shareRule];
    step = makeStep(
      'reject-share',
      { neededBy: ctx.neededBy, capTotal: ctx.capP * limit, requested: ctx.requested, rejectReason },
      [{ type: 'charter', ref: 'maxExternalShare' }, ...sprintSources(ctx.slots, limit)],
    );
  } else if (reason === 'red-line') {
    rejectReason = 'red-line work is never moved';
    rulesUsed = [...redLineRules];
    step = makeStep('reject-red-line', { neededBy: ctx.neededBy, rejectReason }, [{ type: 'charter', ref: 'redLines' }]);
  } else {
    rejectReason = `no delivery date fits within the next ${ctx.slots.length} sprints`;
    rulesUsed = [ctx.shareRule];
    step = makeStep('reject-horizon', { horizonSprints: ctx.slots.length, rejectReason }, [
      { type: 'charter', ref: 'maxExternalShare' },
    ]);
  }
  return draft('reject', {
    dateRange: { min: '', max: '' },
    meetsNeed: false,
    rulesUsed,
    trace: [...ctx.baseTrace, step],
  });
}

function compareDrafts(a: Draft, b: Draft): number {
  const aReject = a.kind === 'reject' ? 1 : 0;
  const bReject = b.kind === 'reject' ? 1 : 0;
  return (
    aReject - bReject ||
    Number(b.meetsNeed) - Number(a.meetsNeed) ||
    a.shiftCost - b.shiftCost ||
    compareStrings(a.dateRange.max, b.dateRange.max) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  );
}

function dedupeKey(option: Draft): string {
  return [
    option.meetsNeed,
    option.dateRange.min,
    option.dateRange.max,
    option.shifted.map((s) => `${s.key}>${s.toSprintId}`).join(','),
    option.remainder ? `${option.remainder.size}@${option.remainder.dateRange.max}` : '',
    option.kind === 'reject' ? 'reject' : '',
  ].join('|');
}

export function planOptions(input: PlannerInput): PlannerResult {
  validateInput(input);
  const { request, charter, capacity, variation } = input;
  const requested = SIZE_ISSUES[request.size];
  const minSize = request.minSize !== undefined && request.minSize < requested ? request.minSize : undefined;
  // Without a minimum part, an earlier-min variation applies to the whole request.
  const neededBy = variation && minSize === undefined ? addDays(request.neededBy, -variation.days) : request.neededBy;
  const neededByMin = variation ? addDays(request.neededBy, -variation.days) : neededBy;

  const horizon = buildHorizon(input.sprints, input.today);
  const slots = assignCommitments(horizon, input.commitments, request.neededBy);
  const committed = slots.map((slot) => slot.items.reduce((sum, item) => sum + itemSize(item), 0));
  const capP = Math.max(0, Math.floor(charter.maxExternalShare * capacity.pessimistic));
  const capR = Math.max(0, Math.floor(charter.maxExternalShare * capacity.realistic));
  const sharePercent = Math.round(charter.maxExternalShare * 100);
  const shareRule = `Maximum share for other teams: ${sharePercent}% of pessimistic capacity per sprint`;
  const limit = eligibleCount(slots, neededBy);

  const baseTrace: TraceStep[] = [
    makeStep(
      'capacity',
      { realistic: capacity.realistic, pessimistic: capacity.pessimistic, sampleCount: capacity.samples.length },
      [],
    ),
  ];
  if (capacity.limitedData) {
    baseTrace.push(
      makeStep('limited-data', { sampleCount: capacity.samples.length, pessimistic: capacity.pessimistic }),
    );
  }
  baseTrace.push(
    makeStep('share-cap', { sharePercent, cap: capP }, [{ type: 'charter', ref: 'maxExternalShare' }]),
    makeStep('requested', { requested, neededBy }),
  );
  if (variation) {
    baseTrace.push(makeStep('variation', { days: variation.days, neededByMin }));
  }
  baseTrace.push(
    makeStep(
      'room-before-need',
      { neededBy, sprintCount: limit, usable: sumUsable(committed, capacity.pessimistic, capP, limit) },
      sprintSources(slots, limit),
    ),
  );

  const ctx: Context = { input, slots, committed, requested, neededBy, capP, capR, baseTrace, shareRule };
  const drafts: Draft[] = [];
  const onTime = onTimeOption(ctx, limit);
  if (onTime) {
    drafts.push(onTime);
    if (minSize !== undefined && variation) {
      const partial = partialOption(ctx, minSize, neededByMin);
      if (partial) drafts.push(partial);
    }
  } else {
    const shareExceeded = requested > capP * limit;
    const shift = shareExceeded ? { redLineBlocked: false, redLineRules: [] } : shiftOption(ctx, limit);
    if (shift.option) drafts.push(shift.option);
    const partial = minSize !== undefined ? partialOption(ctx, minSize, neededByMin) : undefined;
    if (partial) drafts.push(partial);
    const later = laterOption(ctx);
    if (later) drafts.push(later);
    if (shareExceeded) {
      drafts.push(rejectOption(ctx, 'share', [], limit));
    } else if (drafts.length === 0) {
      drafts.push(rejectOption(ctx, shift.redLineBlocked ? 'red-line' : 'horizon', shift.redLineRules, limit));
    }
  }

  const seen = new Set<string>();
  const options: PlannerOption[] = [...drafts]
    .sort(compareDrafts)
    .filter((option) => {
      const key = dedupeKey(option);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_OPTIONS)
    .map((option, index) => ({
      ...option,
      recommended: index === 0,
      consequences: buildConsequences(option.kind, option.trace),
    }));

  return { requested, neededBy, capacity, options };
}
