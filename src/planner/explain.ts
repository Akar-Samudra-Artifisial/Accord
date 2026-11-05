import { betweenDates, formatDate } from '../format/dates';
import { plural } from '../format/text';
import type { OptionKind, TraceSource, TraceStep } from './types';

type Values = Record<string, number | string>;

/**
 * Neutral English templates. Narrative text is rendered only from trace
 * `values`, so every number a user (or an agent) reads is traceable (NFR-1).
 */
const STEP_TEMPLATES: Readonly<Record<string, string>> = {
  capacity:
    'Recent throughput gives {realistic|issue} per sprint (realistic, median of {sampleCount|sprint}) and {pessimistic|issue} per sprint (pessimistic).',
  'limited-data':
    'History covers only {sampleCount|sprint}, so the lowest sprint ({pessimistic|issue}) is used as the pessimistic value.',
  'share-cap':
    'The charter reserves at most {sharePercent}% of pessimistic capacity for other teams, which is {cap|issue} per sprint.',
  requested: 'The request needs {requested|issue} by {neededBy}.',
  variation: 'Variation: the minimum part is evaluated {days|day} earlier, by {neededByMin}.',
  'work-ahead':
    'As the contract monitor projects it, {aheadIssues|issue} of open sprint work and other contracts come first; at {pessimistic|issue} per sprint this request is done by {aheadDate}.',
  'room-before-need':
    'Before {neededBy}, room for {usable|issue} for this request remains in {sprintCount|sprint} after existing commitments.',
  'on-time':
    'Room for {requested|issue} is available by {dateMax} (pessimistic) or {dateMin} (realistic) without moving planned work.',
  shift: 'This option moves {key} ({summary}) from {fromSprint} to {toSprint}.',
  'shift-total':
    'Moving {shiftedCount|planned item} ({shiftedKeys}) has a cost-of-delay weight of {shiftCost} and makes room for {requested|issue} {dateMin..dateMax}.',
  'red-line-kept': '{key} stays in place because the charter marks {rule} as a red line.',
  partial:
    'The minimum part of {minSize|issue} fits by {minDateMax}; the rest ({remainderSize|issue}) follows by {remainderDateMax}.',
  later:
    'Without moving planned work, the earliest delivery is {dateMin..dateMax}, which is {daysLate|day} after {neededBy}.',
  'reject-share':
    'Before {neededBy} the charter share allows at most {capTotal|issue} for other teams, and the request needs {requested}.',
  'reject-red-line': 'Only red-line work could make room before {neededBy}, and red-line work is never moved.',
  'reject-horizon': 'No delivery date fits within the next {horizonSprints|sprint}.',
};

const CONSEQUENCE_TEMPLATES: Readonly<Record<OptionKind, { requester: string; provider: string }>> = {
  'on-time': {
    requester: 'Delivery {dateMin..dateMax}, on or before {neededBy}.',
    provider: 'No planned work moves; the request uses room for {requested|issue} reserved for other teams.',
  },
  'on-time-with-shift': {
    requester: 'Delivery {dateMin..dateMax}, on or before {neededBy}.',
    provider: 'Moves {shiftedCount|planned item} to a later sprint: {shiftedKeys}.',
  },
  partial: {
    requester:
      'The minimum part ({minSize|issue}) arrives by {minDateMax}; the rest ({remainderSize|issue}) by {remainderDateMax}.',
    provider: 'No planned work moves.',
  },
  later: {
    requester: 'Delivery {dateMin..dateMax}, {daysLate|day} after {neededBy}.',
    provider: 'No planned work moves.',
  },
  reject: {
    requester: 'No delivery date is offered as requested; the request can be resized, re-dated, or escalated.',
    provider: 'The charter rule applies: {rejectReason}.',
  },
};

const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fills placeholders from trace values: `{name}` (ISO dates shown as "Nov 29, 2026"; trace values
 * stay ISO), `{name|noun}` for a count with a matching noun ("1 issue", "2 issues"), and
 * `{min..max}` for a date span ("between Nov 20, 2026 and Nov 29, 2026", or "on Nov 29, 2026").
 */
export function renderTemplate(template: string, values: Values): string {
  const value = (name: string) => {
    const found = values[name];
    if (found === undefined) {
      throw new Error(`Missing trace value "${name}" for template "${template}"`);
    }
    return found;
  };
  return template.replace(/\{(\w+)(?:\.\.(\w+)|\|([\w ]+))?\}/g, (_match, name: string, spanEnd?: string, noun?: string) => {
    const found = value(name);
    if (spanEnd !== undefined) return betweenDates(String(found), String(value(spanEnd)));
    if (noun !== undefined) return plural(Number(found), noun);
    return typeof found === 'string' && ISO_DATE_VALUE.test(found) ? formatDate(found) : String(found);
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
