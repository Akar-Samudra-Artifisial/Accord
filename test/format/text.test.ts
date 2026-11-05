import { describe, expect, it } from 'vitest';
import { plural } from '../../src/format/text';

describe('plural', () => {
  it('uses the singular noun only for exactly one', () => {
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(0, 'issue')).toBe('0 issues');
    expect(plural(2, 'sprint')).toBe('2 sprints');
    expect(plural(6.5, 'issue')).toBe('6.5 issues');
  });

  it('accepts an irregular plural form', () => {
    expect(plural(1, 'dependency', 'dependencies')).toBe('1 dependency');
    expect(plural(3, 'dependency', 'dependencies')).toBe('3 dependencies');
  });
});
