import { describe, expect, it } from 'vitest';
import {
  buildCommitments,
  capacityFromSamples,
  costClassOf,
  pickActiveAndNext,
  sampleFromClosedSprint,
  withInferredDates,
  type ThroughputSample,
} from '../../src/capacity/aggregate';
import type { JiraIssue } from '../../src/jira/issues';
import type { Sprint } from '../../src/planner';
import { demoSprintDates, simulatedHistory, DEMO_TEAMS } from '../../src/demo/seed-data';

const issue = (key: string, fields: Partial<JiraIssue['fields']> = {}, done = false): JiraIssue => ({
  id: key,
  key,
  fields: {
    summary: key,
    labels: [],
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    status: { name: done ? 'Done' : 'To Do', statusCategory: { key: done ? 'done' : 'new' } },
    ...fields,
  },
});

const sample = (id: string, count: number, endDate: string, source: ThroughputSample['source']): ThroughputSample => ({
  sprintId: id,
  sprintName: id,
  completedCount: count,
  endDate,
  source,
});

const sprint = (id: string, state: Sprint['state'], startDate: string, endDate: string): Sprint => ({
  id,
  name: id,
  state,
  startDate,
  endDate,
});

describe('sampleFromClosedSprint', () => {
  it('counts only issues in the done status category', () => {
    const result = sampleFromClosedSprint(sprint('7', 'closed', '2026-10-01', '2026-10-14'), [
      issue('A-1', {}, true),
      issue('A-2', {}, true),
      issue('A-3'),
    ]);
    expect(result).toEqual({ sprintId: '7', sprintName: '7', completedCount: 2, endDate: '2026-10-14', source: 'jira' });
  });
});

describe('capacityFromSamples', () => {
  it('prefers Jira history over simulated history', () => {
    const capacity = capacityFromSamples([
      sample('s1', 20, '2026-01-01', 'simulated'),
      sample('j1', 4, '2026-02-01', 'jira'),
      sample('j2', 6, '2026-02-15', 'jira'),
    ]);
    expect(capacity.source).toBe('jira');
    expect(capacity.sourceLabel).toBe('Jira sprint history');
    expect(capacity.samples).toEqual([4, 6]);
    expect(capacity.limitedData).toBe(true);
  });

  it('labels simulated history and uses the last six sprints in date order', () => {
    const samples = [9, 8, 10, 12, 10, 11, 1].map((count, index) =>
      sample(`s${index}`, count, `2026-0${index + 1}-01`, 'simulated'),
    );
    const capacity = capacityFromSamples([...samples].reverse());
    expect(capacity.sourceLabel).toBe('Simulated history');
    expect(capacity.samples).toEqual([8, 10, 12, 10, 11, 1]);
    expect(capacity.realistic).toBe(10);
    expect(capacity.pessimistic).toBe(8);
  });

  it('reports no history when there are no samples', () => {
    expect(capacityFromSamples([])).toMatchObject({ source: 'none', sourceLabel: 'No history', realistic: 0 });
  });
});

describe('costClassOf', () => {
  it('derives fixed date, intangible and standard', () => {
    expect(costClassOf(issue('A', { duedate: '2026-11-20' }))).toBe('fixed-date');
    expect(costClassOf(issue('B', { labels: ['tech-debt'] }))).toBe('intangible');
    expect(costClassOf(issue('C', { priority: { name: 'Low' } }))).toBe('intangible');
    expect(costClassOf(issue('D'))).toBe('standard');
  });
});

describe('buildCommitments', () => {
  const active = sprint('1', 'active', '2026-11-02', '2026-11-15');
  const next = sprint('2', 'future', '2026-11-16', '2026-11-29');

  it('combines open sprint issues and open issues due before the needed-by date without duplicates', () => {
    const result = buildCommitments(
      [
        { sprint: active, issues: [issue('P-1'), issue('P-2', {}, true)] },
        { sprint: next, issues: [issue('P-3', { labels: ['security'] })] },
      ],
      [
        issue('P-1', { duedate: '2026-11-10' }),
        issue('P-4', { duedate: '2026-11-20' }),
        issue('P-5', { duedate: '2026-12-20' }),
        issue('P-6', { duedate: '2026-11-21' }, true),
      ],
      '2026-12-01',
    );
    expect(result.map((item) => [item.key, item.sprintId])).toEqual([
      ['P-1', '1'],
      ['P-3', '2'],
      ['P-4', undefined],
    ]);
    expect(result[1].labels).toEqual(['security']);
    expect(result[2].costClass).toBe('fixed-date');
  });
});

describe('sprint helpers', () => {
  it('infers missing future sprint dates from the previous sprint', () => {
    const result = withInferredDates([
      { id: 1, name: 'S1', state: 'active', startDate: '2026-11-02T09:00:00.000Z', endDate: '2026-11-15T17:00:00.000Z' },
      { id: 2, name: 'S2', state: 'future' },
    ]);
    expect(result[1]).toEqual({ id: '2', name: 'S2', state: 'future', startDate: '2026-11-16', endDate: '2026-11-29' });
  });

  it('picks the active sprint and the earliest future sprint', () => {
    const result = pickActiveAndNext([
      sprint('3', 'future', '2026-12-01', '2026-12-14'),
      sprint('2', 'future', '2026-11-16', '2026-11-29'),
      sprint('1', 'active', '2026-11-02', '2026-11-15'),
    ]);
    expect(result.map((item) => item.id)).toEqual(['1', '2']);
  });
});

describe('demo seed data', () => {
  it('places six simulated sprints back to back before the active sprint', () => {
    const payments = DEMO_TEAMS.find((team) => team.projectKey === 'PAY');
    if (!payments) throw new Error('missing PAY');
    const history = simulatedHistory(payments, '2026-11-05');
    const { activeStart } = demoSprintDates('2026-11-05');
    expect(history).toHaveLength(6);
    expect(history[5].endDate).toBe('2026-11-01');
    expect(activeStart).toBe('2026-11-02');
    expect(history[0].sprintName).toBe('Payments Sprint 35');
    expect(capacityFromSamples(history)).toMatchObject({ realistic: 10, pessimistic: 9, sourceLabel: 'Simulated history' });
  });
});
