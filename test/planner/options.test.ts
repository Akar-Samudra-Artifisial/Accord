import { describe, expect, it } from 'vitest';
import { computeCapacity, explainOption, planOptions } from '../../src/planner';
import type { PlannerOption, PlannerResult } from '../../src/planner';
import { CHARTER, baseInput, fillers, item, shiftScenario } from './fixtures';

const kinds = (result: PlannerResult) => result.options.map((o) => o.kind);

describe('planOptions', () => {
  it('offers on-time without shifting when capacity is enough', () => {
    const result = planOptions(baseInput({ commitments: fillers('PAY', 's1', 5) }));
    expect(kinds(result)).toEqual(['on-time']);
    const [option] = result.options;
    expect(option.recommended).toBe(true);
    expect(option.meetsNeed).toBe(true);
    expect(option.shifted).toEqual([]);
    // 9 - 5 = 4 free, share cap 4 -> 3 issues fit in Sprint 41
    expect(option.dateRange).toEqual({ min: '2026-11-15', max: '2026-11-15' });
  });

  it('shifts the cheapest shiftable work when capacity is short', () => {
    const result = planOptions(
      baseInput({ request: { size: 'L', neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments: shiftScenario() }),
    );
    expect(kinds(result)).toEqual(['on-time-with-shift', 'later']);
    const shift = result.options[0];
    expect(shift.recommended).toBe(true);
    expect(shift.shifted.map((s) => s.key)).toEqual(['PAY-1', 'PAY-11', 'PAY-2', 'PAY-3']);
    expect(shift.shifted.every((s) => s.toSprintId === 's3')).toBe(true);
    expect(shift.shiftCost).toBe(5);
    expect(shift.dateRange).toEqual({ min: '2026-11-29', max: '2026-11-29' });
    expect(shift.rulesUsed).toContain('Shiftable: priority Low');
    expect(explainOption(shift)).toContain('This option moves PAY-1 (Ledger cleanup) from Sprint 41 to Sprint 43.');
    expect(result.options[1]).toMatchObject({ meetsNeed: false, dateRange: { max: '2026-12-13' }, recommended: false });
  });

  it('never shifts red-line work', () => {
    const allRedLine = planOptions(
      baseInput({
        request: { size: 'L', neededBy: '2026-11-29', costClass: 'fixed-date' },
        commitments: shiftScenario({ labels: ['security'] }),
      }),
    );
    expect(kinds(allRedLine)).toEqual(['later']);

    const commitments = shiftScenario().map((w) => {
      if (w.key === 'PAY-1') return { ...w, labels: ['tech-debt', 'security'] };
      if (w.key === 'PAY-2') return { ...w, issueType: 'Incident' };
      // Two more shiftable items in Sprint 41 so the deficit can still be covered.
      if (w.key === 'PAY-100' || w.key === 'PAY-101') return { ...w, priority: 'Low' };
      return w;
    });
    const mixed = planOptions(baseInput({ request: { size: 'L', neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments }));
    const shift = mixed.options.find((o) => o.kind === 'on-time-with-shift');
    expect(shift).toBeDefined();
    const shiftedKeys = shift?.shifted.map((s) => s.key) ?? [];
    expect(shiftedKeys).not.toContain('PAY-1');
    expect(shiftedKeys).not.toContain('PAY-2');
    expect(shift?.rulesUsed).toEqual(expect.arrayContaining(['Red line: label security', 'Red line: issue type Incident']));
    expect(shift?.trace.some((t) => t.step === 'red-line-kept' && t.values.key === 'PAY-1')).toBe(true);
  });

  it('rejects with the charter share rule when the request exceeds the maximum share', () => {
    const result = planOptions(
      baseInput({
        charter: { ...CHARTER, maxExternalShare: 0.25 },
        request: { size: 'L', neededBy: '2026-11-15', costClass: 'standard' },
      }),
    );
    expect(kinds(result)).toEqual(['later', 'reject']);
    const reject = result.options[1];
    expect(reject.recommended).toBe(false);
    expect(reject.rulesUsed).toEqual(['Maximum share for other teams: 25% of pessimistic capacity per sprint']);
    expect(reject.consequences.provider).toContain('25%');
    // floor(0.25 * 9) = 2 per sprint -> 6 issues after three sprints
    expect(result.options[0].dateRange.max).toBe('2026-12-13');
  });

  it('offers a partial option for the minimum useful part', () => {
    const result = planOptions(
      baseInput({
        request: { size: 'L', minSize: 2, neededBy: '2026-11-15', costClass: 'fixed-date' },
        commitments: fillers('PAY', 's1', 5),
      }),
    );
    expect(kinds(result)).toEqual(['partial', 'later', 'reject']);
    const partial = result.options[0];
    expect(partial.recommended).toBe(true);
    expect(partial.dateRange.max).toBe('2026-11-15');
    expect(partial.remainder).toEqual({ size: 4, dateRange: result.options[1].dateRange });
  });

  it('marks limited data when fewer than four sprints exist', () => {
    const capacity = computeCapacity([5, 7, 6]);
    const result = planOptions(baseInput({ capacity }));
    expect(result.capacity.limitedData).toBe(true);
    const step = result.options[0].trace.find((t) => t.step === 'limited-data');
    expect(step?.values).toEqual({ sampleCount: 3, pessimistic: 5 });
  });

  it('evaluates the earlier-min variation', () => {
    const input = baseInput({
      request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' },
      commitments: [...fillers('PAY', 's1', 7), ...fillers('PAZ', 's2', 6)],
    });
    const earlier = planOptions({ ...input, variation: { kind: 'earlier-min', days: 14 } });
    const partial = earlier.options.find((o) => o.kind === 'partial');
    expect(partial?.dateRange.max).toBe('2026-11-15');
    expect(partial?.trace.find((t) => t.step === 'variation')?.values).toEqual({ days: 14, neededByMin: '2026-11-15' });

    const tooEarly = planOptions({ ...input, variation: { kind: 'earlier-min', days: 20 } });
    expect(tooEarly.options.some((o) => o.kind === 'partial')).toBe(false);
  });

  it('sorts by need, then shift cost, then date, with at most four options', () => {
    const result = planOptions(
      baseInput({
        request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' },
        commitments: shiftScenario(),
      }),
    );
    expect(kinds(result)).toEqual(['partial', 'on-time-with-shift', 'later']);
    expect(result.options.length).toBeLessThanOrEqual(4);
    expect(result.options.filter((o) => o.recommended).map((o) => o.kind)).toEqual(['partial']);
  });

  it('is deterministic regardless of input order', () => {
    const input = baseInput({
      request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' },
      commitments: shiftScenario(),
    });
    const first = planOptions(input);
    expect(planOptions(input)).toEqual(first);
    expect(planOptions({ ...input, commitments: [...input.commitments].reverse(), sprints: [...input.sprints].reverse() })).toEqual(
      first,
    );
  });

  it('only uses numbers from trace values in narratives and consequences', () => {
    const scenarios = [
      baseInput({ commitments: fillers('PAY', 's1', 5) }),
      baseInput({ request: { size: 'L', minSize: 2, neededBy: '2026-11-29', costClass: 'fixed-date' }, commitments: shiftScenario() }),
      baseInput({ charter: { ...CHARTER, maxExternalShare: 0.25 }, request: { size: 'L', neededBy: '2026-11-15', costClass: 'standard' } }),
      baseInput({ capacity: computeCapacity([5, 7, 6]), variation: { kind: 'earlier-min', days: 3 } }),
    ];
    const token = /[A-Z][A-Z0-9]*-\d+|\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?/g;
    const check = (option: PlannerOption) => {
      const allowed = new Set<string>();
      for (const step of option.trace) {
        for (const value of Object.values(step.values)) {
          allowed.add(String(value));
          for (const t of String(value).match(token) ?? []) allowed.add(t);
        }
      }
      const text = [explainOption(option), option.consequences.requester, option.consequences.provider].join(' ');
      for (const t of text.match(token) ?? []) {
        expect(allowed, `"${t}" in ${option.kind}`).toContain(t);
      }
    };
    for (const input of scenarios) planOptions(input).options.forEach(check);
  });

  it('counts unscheduled work due before the needed-by date in the first sprint', () => {
    const result = planOptions(
      baseInput({
        request: { size: 'M', neededBy: '2026-11-15', costClass: 'standard' },
        commitments: [...fillers('PAY', 's1', 5), item('OPS-1', undefined, { dueDate: '2026-11-10', size: 2 })],
      }),
    );
    // 9 - 7 = 2 free < 3 requested -> not on time
    expect(result.options[0].kind).not.toBe('on-time');
  });

  it('validates dates', () => {
    expect(() => planOptions(baseInput({ today: '2026-02-30' }))).toThrow(/not a real calendar date/);
  });
});
