import { describe, expect, it } from 'vitest';
import {
  buildCharterStorage,
  parseCharterSections,
  parseRuleLine,
  validateCharterStorage,
  type CharterTemplateInput,
} from '../../src/confluence/charter';

const template: CharterTemplateInput = {
  teamName: 'Payments',
  priorities: ['Holiday release', 'Ledger migration'],
  redLines: [
    { field: 'label', value: 'security' },
    { field: 'issueType', value: 'Incident' },
  ],
  shiftable: [
    { field: 'priority', value: 'Low' },
    { field: 'label', value: 'tech-debt' },
  ],
  maxExternalShare: 0.25,
  responseDays: 2,
  approverAccountIds: ['557058:lead-1'],
  escalationAccountId: '557058:manager-1',
};

describe('charter template round trip', () => {
  it('parses the generated template back into the same charter', () => {
    const result = validateCharterStorage(buildCharterStorage(template));
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.charter).toEqual({
      priorities: ['Holiday release', 'Ledger migration'],
      redLines: template.redLines,
      shiftable: template.shiftable,
      maxExternalShare: 0.25,
      responseDays: 2,
      approvers: ['557058:lead-1'],
      escalationContact: '557058:manager-1',
    });
  });

  it('escapes team names and values in storage format', () => {
    const storage = buildCharterStorage({ ...template, teamName: 'R&D <core>', priorities: ['A & B'] });
    expect(storage).toContain('R&amp;D &lt;core&gt;');
    expect(validateCharterStorage(storage).charter?.priorities).toEqual(['A & B']);
  });
});

describe('validateCharterStorage', () => {
  it('lists every required heading when the page is empty', () => {
    const result = validateCharterStorage('<p>Hello</p>');
    expect(result.valid).toBe(false);
    expect(result.charter).toBeNull();
    expect(result.missing).toEqual([
      'Quarter priorities',
      'Red lines',
      'Shiftable work',
      'Max share for other teams',
      'Response time',
      'Approvers',
    ]);
  });

  it('reports unreadable rules, out-of-range share and missing approver mentions', () => {
    const storage =
      '<h2>Quarter priorities</h2><ol><li><p>Goal</p></li></ol>' +
      '<h2>Red lines</h2><ul><li><p>never touch security stuff</p></li></ul>' +
      '<h2>Shiftable work</h2><p>Priority: Low, Medium</p>' +
      '<h2>Max share for other teams</h2><p>150%</p>' +
      '<h2>Response time</h2><p>2 working days</p>' +
      '<h2>Approvers</h2><p>The team lead</p>';
    const result = validateCharterStorage(storage);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['Red lines', 'Max share for other teams', 'Approvers']);
    expect(result.problems.find((p) => p.field === 'redLines')?.message).toContain('never touch security stuff');
  });

  it('accepts headings with different case and a decimal share', () => {
    const storage =
      '<h2>QUARTER PRIORITIES</h2><p>Goal</p>' +
      '<h2>Red lines</h2><p>Label: security</p>' +
      '<h2>Shiftable work</h2><p>Issue type: Task</p>' +
      '<h2>Max share for other teams</h2><p>0.3</p>' +
      '<h2>Response time</h2><p>3 days</p>' +
      '<h2>Approvers</h2><p><ac:link><ri:user ri:account-id="abc" /></ac:link></p>';
    const result = validateCharterStorage(storage);
    expect(result.valid).toBe(true);
    expect(result.charter?.maxExternalShare).toBeCloseTo(0.3);
    expect(result.charter?.responseDays).toBe(3);
    expect(result.charter?.escalationContact).toBeUndefined();
  });
});

describe('parseCharterSections', () => {
  it('ignores content before the first heading and unknown headings', () => {
    const sections = parseCharterSections('<p>Intro</p><h2>Notes</h2><p>x</p><h2>Red lines</h2><p>Label: a</p>');
    expect(Object.keys(sections)).toEqual(['redLines']);
  });
});

describe('parseRuleLine', () => {
  it('splits comma separated values', () => {
    expect(parseRuleLine('Priority: Low, Medium')).toEqual([
      { field: 'priority', value: 'Low' },
      { field: 'priority', value: 'Medium' },
    ]);
  });

  it('returns null for free text or unknown fields', () => {
    expect(parseRuleLine('anything goes')).toBeNull();
    expect(parseRuleLine('Component: api')).toBeNull();
  });
});
