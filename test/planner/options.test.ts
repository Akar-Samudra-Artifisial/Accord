import { describe, expect, it } from 'vitest';
import { SIZE_ISSUES, computeCapacity, explainOption, planOptions } from '../../src/planner';
import type { PlannerInput, PlannerOption, PlannerResult, Size, WorkItem } from '../../src/planner';
import { projectContract } from '../../src/planner/projection';
import { formatDate } from '../../src/format/dates';
import { buildConsequences, makeStep } from '../../src/planner/explain';
import { CHARTER, SPRINTS, baseInput, fillers, item, shiftScenario } from './fixtures';

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

  it('renegotiation (workAhead): never earlier than the monitor projection, with a shift option that lowers it', () => {
    const commitments = shiftScenario();
    const input = baseInput({
      request: { size: 'S', neededBy: '2026-11-29', costClass: 'standard' },
      commitments,
      workAhead: { issues: 20, countedKeys: commitments.map((c) => c.key), countedSprintIds: ['s1', 's2'], pinnedKeys: ['PAY-3'] },
    });
    // Without the floor the request would fit on time in Sprint 41/42.
    expect(planOptions({ ...input, workAhead: undefined }).options[0]).toMatchObject({ kind: 'on-time', meetsNeed: true });
    const result = planOptions(input);
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    // 20 ahead + 1 at 9 per sprint: done in the third sprint (Sprint 43) unless counted work moves out.
    const plain = result.options.filter((o) => o.shifted.length === 0 && o.kind !== 'reject');
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((o) => (o.dateRange?.max ?? '') >= '2026-12-13')).toBe(true);
    const shift = result.options.find((o) => o.kind === 'on-time-with-shift');
    expect(shift?.dateRange?.max).toBe('2026-11-29');
    expect(shift?.shifted.map((s) => s.key)).not.toContain('PAY-3');
    expect(explainOption(plain[0])).toContain('As the contract monitor projects it, 20 issues of open sprint work');
  });

  it('monitor rule: shiftable counted work of the next sprint (after the need) moves out of the window, never into it', () => {
    // 8 non-shiftable issues in Sprint 41, 1 Low in Sprint 42; need by Nov 26 → only Sprint 41 is before the need.
    const commitments = [...fillers('PAY', 's1', 8), item('PAY-20', 's2', { priority: 'Low', costClass: 'intangible' })];
    const input = baseInput({
      request: { size: 'S', neededBy: '2026-11-26', costClass: 'standard' },
      commitments,
      workAhead: { issues: 9, countedKeys: commitments.map((c) => c.key), countedSprintIds: ['s1', 's2'] },
    });
    const result = planOptions(input);
    // 9 ahead + 1 at 9 per sprint → Sprint 42 (Nov 29) unless PAY-20 leaves Sprint 41/42.
    expect(result.options.map((o) => [o.kind, o.dateRange.max])).toEqual([
      ['on-time-with-shift', '2026-11-15'],
      ['later', '2026-11-29'],
    ]);
    expect(result.options[0].shifted).toEqual([{ key: 'PAY-20', costClass: 'intangible', toSprintId: 's3' }]);
    // Without the monitor rule, Sprint 42 work after the need is no candidate.
    expect(planOptions({ ...input, workAhead: undefined }).options.map((o) => o.kind)).toEqual(['on-time']);
  });

  describe('monitor order of contracts (workAhead.contracts)', () => {
    type Existing = { agreedDateMax: string; size: Size };
    /** Monitor statuses after applying `option`: contracts by agreed latest date, existing first on ties. */
    const statusesAfterApply = (input: PlannerInput, existing: Existing[], option: PlannerOption) => {
      const all = [
        ...existing.map((c, i) => ({ id: `old-${i}`, order: i, ...c })),
        { id: 'new', order: existing.length, agreedDateMax: option.dateRange.max, size: input.request.size },
      ].sort((a, b) => a.agreedDateMax.localeCompare(b.agreedDateMax) || a.order - b.order);
      const base = input.workAhead!.issues - existing.reduce((sum, c) => sum + SIZE_ISSUES[c.size], 0);
      return Object.fromEntries(
        all.map((c, i) => [
          c.id,
          projectContract({
            sprints: input.sprints,
            today: input.today,
            pessimistic: input.capacity.pessimistic,
            committedIssues: base,
            earlierContractSizes: all.slice(0, i).map((e) => e.size),
            size: c.size,
            agreedDateMax: c.agreedDateMax,
          }).status,
        ]),
      );
    };
    const withContracts = (existing: Existing[], commitments: WorkItem[], counted: WorkItem[], extra: Partial<PlannerInput> = {}) =>
      baseInput({
        request: { size: 'S', neededBy: '2026-11-15', costClass: 'standard' },
        commitments,
        workAhead: {
          issues: counted.length + existing.reduce((sum, c) => sum + SIZE_ISSUES[c.size], 0),
          countedKeys: counted.map((c) => c.key),
          countedSprintIds: ['s1', 's2'],
          contracts: existing.map((c) => ({ agreedDateMax: c.agreedDateMax, issues: SIZE_ISSUES[c.size] })),
        },
        ...extra,
      });

    it('a contract agreed later is not ahead: the new request gets the earlier date and the old contract stays on track', () => {
      const counted = fillers('PAY', 's1', 3);
      const existing: Existing[] = [{ agreedDateMax: '2026-12-27', size: 'L' }];
      const input = withContracts(existing, counted, counted);
      const [best] = planOptions(input).options;
      // 3 counted + this 1 at 9 per sprint → Sprint 41; the L contract (Dec 27) is pushed back: 3 + 1 + 6 → Nov 29.
      expect([best.kind, best.dateRange.max]).toEqual(['on-time', '2026-11-15']);
      expect(statusesAfterApply(input, existing, best)).toEqual({ new: 'on-track', 'old-0': 'on-track' });
      // Counting every contract as ahead (no order) misses Nov 15: 3 + 6 + 1 → Nov 29.
      const { contracts: _ignored, ...unordered } = input.workAhead!;
      expect(planOptions({ ...input, workAhead: unordered }).options.map((o) => o.kind)).not.toContain('on-time');
    });

    it('an earlier date that would push an on-track contract at risk is not offered; deliverables in a sprint stay put', () => {
      const counted = fillers('PAY', 's1', 3);
      // 3 counted + 6 + 6 + 3 = 18 = two sprints at 9: on track by Nov 29 with no slack left.
      const existing: Existing[] = [
        { agreedDateMax: '2026-11-29', size: 'L' },
        { agreedDateMax: '2026-11-29', size: 'L' },
        { agreedDateMax: '2026-11-29', size: 'M' },
      ];
      // The first contract's deliverable already sits in Sprint 42 (low priority, otherwise shiftable).
      const deliverable = item('PAY-50', 's2', { priority: 'Low', costClass: 'intangible' });
      const input = withContracts(existing, [...counted, deliverable], counted);
      input.workAhead!.pinnedKeys = ['PAY-50'];
      const options = planOptions(input).options;
      // Nov 15 fits the room (3 + 1 ≤ 9) but puts all three contracts at risk (19 > 18): next date that holds is Dec 13.
      expect(options.map((o) => [o.kind, o.dateRange.max])).toEqual([['later', '2026-12-13']]);
      expect(options.flatMap((o) => o.shifted.map((s) => s.key))).not.toContain('PAY-50');
      for (const option of options) {
        expect(Object.values(statusesAfterApply(input, existing, option)).every((s) => s === 'on-track')).toBe(true);
      }
    });
  });

  it('names the backlog as the destination when the next free sprint does not exist in Jira yet', () => {
    // Only Sprint 41 and 42 exist (both counted by the monitor): the move target is a projected sprint.
    const commitments = [...fillers('PAY', 's1', 8), item('PAY-20', 's2', { priority: 'Low', costClass: 'intangible' })];
    const result = planOptions(
      baseInput({
        request: { size: 'S', neededBy: '2026-11-26', costClass: 'standard' },
        sprints: SPRINTS.filter((s) => s.id !== 's3'),
        commitments,
        workAhead: { issues: 9, countedKeys: commitments.map((c) => c.key), countedSprintIds: ['s1', 's2'] },
      }),
    );
    const shift = result.options.find((o) => o.kind === 'on-time-with-shift')!;
    expect(shift.shifted).toEqual([{ key: 'PAY-20', costClass: 'intangible', toSprintId: 'projected-1' }]);
    expect(shift.consequences.provider).toBe('Moves 1 planned item to the backlog: PAY-20.');
    expect(explainOption(shift)).toContain('from Sprint 42 to the backlog.');
    expect(explainOption(shift)).not.toMatch(/later sprint|Projected sprint/);
  });

  it('a stored trace that still names the projected sprint renders the backlog as the destination', () => {
    const trace = [
      makeStep('shift', { key: 'PAY-12', summary: 'Work', fromSprint: 'Payments Sprint 41', toSprint: 'Projected sprint 1' }, [
        { type: 'issue', ref: 'PAY-12' },
        { type: 'sprint', ref: 'projected-1' },
      ]),
      makeStep('shift-total', { shiftedCount: 1, shiftedKeys: 'PAY-12', shiftCost: 1, requested: 1, dateMin: '2026-11-15', dateMax: '2026-11-15' }),
      makeStep('requested', { requested: 1, neededBy: '2026-11-26' }),
    ];
    expect(buildConsequences('on-time-with-shift', trace).provider).toBe('Moves 1 planned item to the backlog: PAY-12.');
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
    // Sprint 43 exists in Jira: the text names it.
    expect(shift.consequences.provider).toBe('Moves 4 planned items to Sprint 43: PAY-1, PAY-11, PAY-2, PAY-3.');
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
          // ISO date values are rendered as "Nov 29, 2026"; their day and year are traced numbers too.
          for (const t of formatDate(String(value)).match(token) ?? []) allowed.add(t);
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
