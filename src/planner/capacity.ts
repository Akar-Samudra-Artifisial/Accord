import type { CapacityRange } from './types';

export const CAPACITY_WINDOW = 6;
export const MIN_SAMPLES_FOR_FULL_DATA = 4;

/**
 * Capacity from completed-issue counts per sprint (oldest first).
 * Uses the last 6 sprints: realistic = median, pessimistic = second lowest.
 * With fewer than 4 samples the data is flagged as limited and the
 * pessimistic value falls back to the minimum.
 */
export function computeCapacity(completedPerSprint: readonly number[]): CapacityRange {
  for (const value of completedPerSprint) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid throughput sample ${value}: expected a non-negative number`);
    }
  }
  const samples = completedPerSprint.slice(-CAPACITY_WINDOW);
  if (samples.length === 0) {
    return { pessimistic: 0, realistic: 0, samples: [], limitedData: true };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const realistic = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const limitedData = sorted.length < MIN_SAMPLES_FOR_FULL_DATA;
  const pessimistic = limitedData ? sorted[0] : sorted[1];
  return { pessimistic, realistic, samples, limitedData };
}
