import type { OptionKind, TraceSource, TraceStep } from './types';

type Values = Record<string, number | string>;

/**
 * Neutral English templates. Narrative text is rendered only from trace
 * `values`, so every number a user (or an agent) reads is traceable (NFR-1).
 */
const STEP_TEMPLATES: Readonly<Record<string, string>> = {
  capacity:
    'Recent throughput gives {realistic} issues per sprint (realistic, median of {sampleCount} sprints) and {pessimistic} issues per sprint (pessimistic).',
  'limited-data':
    'Only {sampleCount} sprints of history are available, so the lowest sprint ({pessimistic} issues) is used as the pessimistic value.',
  'share-cap':
    'The charter reserves at most {sharePercent}% of pessimistic capacity for other teams, which is {cap} issues per sprint.',
  requested: 'The request needs {requested} issues by {neededBy}.',
  variation: 'Variation: the minimum part is evaluated {days} days earlier, by {neededByMin}.',
  'room-before-need':
    'Before {neededBy}, {sprintCount} sprints have room for {usable} issues for this request after existing commitments.',
  'on-time':
    'Room for {requested} issues is available by {dateMax} (pessimistic) or {dateMin} (realistic) without moving planned work.',
  shift: 'This option moves {key} ({summary}) from {fromSprint} to {toSprint}.',
  'shift-total':
    'Moving {shiftedCount} planned items ({shiftedKeys}) has a cost-of-delay weight of {shiftCost} and makes room for {requested} issues between {dateMin} and {dateMax}.',
  'red-line-kept': '{key} stays in place because the charter marks {rule} as a red line.',
  partial:
    'The minimum part of {minSize} issues fits by {minDateMax}; the remaining {remainderSize} issues follow by {remainderDateMax}.',
  later:
    'Without moving planned work, the earliest delivery is {dateMin} to {dateMax}, which is {daysLate} days after {neededBy}.',
  'reject-share':
    'Before {neededBy} the charter share allows at most {capTotal} issues for other teams, and the request needs {requested}.',
  'reject-red-line': 'Only red-line work could make room before {neededBy}, and red-line work is never moved.',
  'reject-horizon': 'No delivery date fits within the next {horizonSprints} sprints.',
};

const CONSEQUENCE_TEMPLATES: Readonly<Record<OptionKind, { requester: string; provider: string }>> = {
  'on-time': {
    requester: 'Delivery between {dateMin} and {dateMax}, on or before {neededBy}.',
    provider: 'No planned work moves; {requested} issues use room reserved for other teams.',
  },
  'on-time-with-shift': {
    requester: 'Delivery between {dateMin} and {dateMax}, on or before {neededBy}.',
    provider: '{shiftedCount} planned items move to a later sprint: {shiftedKeys}.',
  },
  partial: {
    requester:
      'The minimum {minSize} issues arrive by {minDateMax}; the remaining {remainderSize} issues by {remainderDateMax}.',
    provider: 'No planned work moves.',
  },
  later: {
    requester: 'Delivery between {dateMin} and {dateMax}, {daysLate} days after {neededBy}.',
    provider: 'No planned work moves.',
  },
  reject: {
    requester: 'No delivery date is offered as requested; the request can be resized, re-dated, or escalated.',
    provider: 'The charter rule applies: {rejectReason}.',
  },
};

export function renderTemplate(template: string, values: Values): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Missing trace value "${name}" for template "${template}"`);
    }
    return String(value);
  });
}

export function makeStep(step: string, values: Values, sources: TraceSource[] = []): TraceStep {
  const template = STEP_TEMPLATES[step];
  if (template === undefined) {
    throw new Error(`Unknown trace step "${step}"`);
  }
  return { step, text: renderTemplate(template, values), values: { ...values }, sources };
}

export function mergeTraceValues(trace: readonly TraceStep[]): Values {
  return trace.reduce<Values>((acc, step) => ({ ...acc, ...step.values }), {});
}

export function buildConsequences(
  kind: OptionKind,
  trace: readonly TraceStep[],
): { requester: string; provider: string } {
  const values = mergeTraceValues(trace);
  const templates = CONSEQUENCE_TEMPLATES[kind];
  return {
    requester: renderTemplate(templates.requester, values),
    provider: renderTemplate(templates.provider, values),
  };
}

/** Step-by-step narrative for an option, built only from its trace. */
export function explainOption(option: { trace: readonly TraceStep[] }): string {
  return option.trace.map((step) => step.text).join(' ');
}
