import { describe, expect, it } from 'vitest';
import { formatDate } from '../../src/format/dates';
import { planOptions } from '../../src/planner';
import type { PlannerOption, TraceStep } from '../../src/planner';
import {
  approvalState,
  buildTranscript,
  previewChanges,
  rankOptions,
  requesterDecision,
  VARIATION_DAYS,
} from '../../src/negotiation/delegates';
import type { Approval, StoredOption } from '../../src/negotiation/types';
import { baseInput, shiftScenario } from '../planner/fixtures';

let nextId = 1;
function stored(option: PlannerOption, roundId = 1): StoredOption {
  return {
    id: nextId++,
    requestId: 'req-1',
    roundId,
    kind: option.kind,
    dateRange: option.dateRange,
    shifted: option.shifted,
    rulesUsed: option.rulesUsed,
    trace: option.trace,
    meetsNeed: option.meetsNeed,
    shiftCost: option.shiftCost,
    recommended: false,
  };
}

const ISSUE_KEY = /[A-Z][A-Z0-9_]+-\d+/g;
const NUMBER = /\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?/g;

function numbersIn(text: string): string[] {
  return text.replace(ISSUE_KEY, ' ').match(NUMBER) ?? [];
}

function traceNumbers(options: readonly StoredOption[]): Set<string> {
  const values = options.flatMap((option) => option.trace.flatMap((step: TraceStep) => Object.values(step.values)));
  // An ISO date value is shown as "Nov 29, 2026", so its day and year count as traced numbers too.
  return new Set(values.flatMap((value) => [...numbersIn(String(value)), ...numbersIn(formatDate(String(value)))]));
}

describe('requesterDecision', () => {
  it('accepts when an option meets the need', () => {
    expect(requesterDecision({ minSize: 1 }, [{ meetsNeed: false }, { meetsNeed: true }])).toEqual({
      action: 'accept',
      reason: 'meets-need',
    });
  });

  it('asks for the minimum part earlier only when nothing meets the need and a minimum exists', () => {
    expect(requesterDecision({ minSize: 1 }, [{ meetsNeed: false }])).toEqual({
      action: 'request-variation',
      variation: { kind: 'earlier-min', days: VARIATION_DAYS },
    });
    expect(requesterDecision({ minSize: null }, [{ meetsNeed: false }])).toEqual({ action: 'accept', reason: 'no-minimum' });
  });
});

describe('rankOptions', () => {
  it('puts options meeting the need first, declines last, and drops duplicates', () => {
    const round1 = planOptions(
      baseInput({ request: { size: 'L', neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments: shiftScenario() }),
    ).options.map((o) => stored(o, 1));
    const duplicate = { ...round1[0], id: nextId++, roundId: 2 };
    const ranked = rankOptions([round1[1], duplicate, round1[0]]);
    expect(ranked.map((o) => o.kind)).toEqual(['on-time-with-shift', 'later']);
    expect(ranked[0].id).toBe(round1[0].id);
  });

  it('keeps at most four options', () => {
    const options = Array.from({ length: 6 }, (_, i) => ({
      ...stored(planOptions(baseInput()).options[0]),
      dateRange: { min: `2026-12-0${i + 1}`, max: `2026-12-0${i + 1}` },
    }));
    expect(rankOptions(options)).toHaveLength(4);
  });
});

describe('buildTranscript', () => {
  it('only uses numbers that appear in planner trace values (NFR-1)', () => {
    const round1 = planOptions(
      baseInput({ request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments: shiftScenario() }),
    ).options.map((o) => stored(o, 1));
    const variation = planOptions(
      baseInput({
        request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' },
        commitments: shiftScenario(),
        variation: { kind: 'earlier-min', days: 2 },
      }),
    ).options.map((o) => stored(o, 2));
    const all = [...round1, ...variation];
    const lines = buildTranscript({
      requesterName: 'Mobile',
      providerName: 'Payments',
      round1,
      variation,
      decision: { action: 'request-variation', variation: { kind: 'earlier-min', days: 2 } },
      ranked: rankOptions(all),
    });
    expect(lines.map((l) => l.round)).toContain(2);
    expect(lines.some((l) => l.speaker === 'Mobile Delegate' && l.text.includes('2 days earlier'))).toBe(true);
    const allowed = traceNumbers(all);
    for (const line of lines) {
      for (const number of numbersIn(line.text)) expect(allowed, `"${number}" in "${line.text}"`).toContain(number);
    }
  });

  it('uses neutral language and never claims an approval', () => {
    const round1 = planOptions(baseInput({ commitments: shiftScenario() })).options.map((o) => stored(o));
    const text = buildTranscript({
      requesterName: 'Mobile',
      providerName: 'Payments',
      round1,
      variation: [],
      decision: { action: 'accept', reason: 'meets-need' },
      ranked: rankOptions(round1),
    })
      .map((l) => l.text)
      .join(' ');
    expect(text).not.toMatch(/must give in|has to accept|approved by the broker/i);
    expect(text).toContain("Accord never approves on a team's behalf");
  });
});

describe('previewChanges', () => {
  it('lists every Jira change of an option before approval', () => {
    const [shift] = planOptions(
      baseInput({ request: { size: 'L', neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments: shiftScenario() }),
    ).options.map((o) => stored(o));
    const changes = previewChanges({ title: 'Refund API', sourceIssueKey: 'MOB-7' }, 'PAY', shift);
    expect(changes.map((c) => c.kind)).toEqual(['create-issue', 'link', 'move-sprint', 'move-sprint', 'move-sprint', 'move-sprint', 'move-sprint', 'comment']);
    expect(changes[2].text).toBe('Plan the new issue in Sprint 42.');
    expect(changes[3].text).toBe('Move PAY-1 to Sprint 43.');
  });
});

describe('approvalState', () => {
  const approval = (id: number, teamId: string, optionId: number, decision: Approval['decision'] = 'approve'): Approval => ({
    id,
    requestId: 'req-1',
    optionId,
    teamId,
    actorAccountId: 'someone',
    decision,
    reason: null,
    createdAt: '',
  });

  it('agrees only when both latest decisions approve the same option', () => {
    expect(approvalState([approval(1, 'A', 5), approval(2, 'B', 6)], 'A', 'B').agreedOptionId).toBeNull();
    expect(approvalState([approval(1, 'A', 5), approval(2, 'B', 6), approval(3, 'B', 5)], 'A', 'B').agreedOptionId).toBe(5);
    expect(approvalState([approval(1, 'A', 5), approval(2, 'B', 5, 'reject')], 'A', 'B')).toMatchObject({
      agreedOptionId: null,
      rejected: { teamId: 'B' },
    });
  });
});
