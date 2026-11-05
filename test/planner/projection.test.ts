import { describe, expect, it } from 'vitest';
import { projectContract, type ProjectionInput, type Sprint } from '../../src/planner';

const SPRINTS: Sprint[] = [
  { id: '2', name: 'Payments Sprint 41', startDate: '2026-11-01', endDate: '2026-11-14', state: 'active' },
  { id: '4', name: 'Payments Sprint 42', startDate: '2026-11-15', endDate: '2026-11-28', state: 'future' },
];

const input = (overrides: Partial<ProjectionInput> = {}): ProjectionInput => ({
  sprints: SPRINTS,
  today: '2026-11-05',
  pessimistic: 9,
  committedIssues: 11,
  earlierContractSizes: [],
  size: 'M',
  agreedDateMax: '2026-11-28',
  ...overrides,
});

describe('projectContract', () => {
  it('is on-track when the work fits before the agreed latest date', () => {
    expect(projectContract(input())).toEqual({ status: 'on-track', projectedDate: '2026-11-28', workAhead: 14 });
  });

  it('is on-track when the projection lands exactly on the agreed date', () => {
    const result = projectContract(input({ committedIssues: 12, earlierContractSizes: ['M'] }));
    expect(result).toEqual({ status: 'on-track', projectedDate: '2026-11-28', workAhead: 18 });
  });

  it('becomes at-risk when new work pushes the projection past the agreed date', () => {
    // two extra critical bugs: 14 committed + earlier M + this M = 20 > 18
    const result = projectContract(input({ committedIssues: 14, earlierContractSizes: ['M'] }));
    expect(result).toEqual({ status: 'at-risk', projectedDate: '2026-12-12', workAhead: 20 });
  });

  it('recovers to on-track when the extra work is removed', () => {
    const atRisk = projectContract(input({ committedIssues: 14, earlierContractSizes: ['M'] }));
    const recovered = projectContract(input({ committedIssues: 12, earlierContractSizes: ['M'] }));
    expect([atRisk.status, recovered.status]).toEqual(['at-risk', 'on-track']);
  });

  it('is at-risk without a projection when capacity is zero', () => {
    expect(projectContract(input({ pessimistic: 0 }))).toEqual({ status: 'at-risk', projectedDate: null, workAhead: 14 });
  });

  it('is at-risk when the work does not fit within the horizon', () => {
    const result = projectContract(input({ pessimistic: 1, committedIssues: 40 }));
    expect(result.status).toBe('at-risk');
    expect(result.projectedDate).toBeNull();
  });

  it('rejects invalid capacity and commitment numbers', () => {
    expect(() => projectContract(input({ pessimistic: -1 }))).toThrow(/pessimistic/);
    expect(() => projectContract(input({ committedIssues: 1.5 }))).toThrow(/committedIssues/);
  });
});
