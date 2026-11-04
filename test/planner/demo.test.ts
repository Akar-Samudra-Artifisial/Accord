import { describe, expect, it } from 'vitest';
import { planOptions } from '../../src/planner';
import { demoPlannerInput } from '../../src/demo/scenario';

describe('demo scenario', () => {
  it('produces a recommended option and never moves red-line work', () => {
    const result = planOptions(demoPlannerInput());
    expect(result.options.map((o) => o.kind)).toEqual(['partial', 'on-time-with-shift', 'later']);
    expect(result.options[0].recommended).toBe(true);
    const shiftedKeys = result.options.flatMap((o) => o.shifted.map((s) => s.key));
    expect(shiftedKeys).not.toContain('PAY-103');
  });
});
