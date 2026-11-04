import { describe, expect, it } from 'vitest';
import { computeCapacity } from '../../src/planner';

describe('computeCapacity', () => {
  it('uses the median as realistic and the second lowest sprint as pessimistic', () => {
    expect(computeCapacity([8, 10, 9, 12, 10, 11])).toEqual({
      realistic: 10,
      pessimistic: 9,
      samples: [8, 10, 9, 12, 10, 11],
      limitedData: false,
    });
  });

  it('only looks at the last six sprints', () => {
    const capacity = computeCapacity([1, 1, 8, 10, 9, 12, 10, 11]);
    expect(capacity.samples).toEqual([8, 10, 9, 12, 10, 11]);
    expect(capacity.pessimistic).toBe(9);
  });

  it('flags limited data below four sprints and falls back to the minimum', () => {
    expect(computeCapacity([5, 7, 6])).toEqual({ realistic: 6, pessimistic: 5, samples: [5, 7, 6], limitedData: true });
    expect(computeCapacity([])).toEqual({ realistic: 0, pessimistic: 0, samples: [], limitedData: true });
  });

  it('rejects negative samples', () => {
    expect(() => computeCapacity([3, -1])).toThrow(/Invalid throughput sample -1/);
  });
});
