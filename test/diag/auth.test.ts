import { describe, expect, it } from 'vitest';
import { diagAuthorized } from '../../src/diag/auth';

const KEY = 'k'.repeat(64);
const env = { ACCORD_DIAG_ENABLED: 'true', ACCORD_DIAG_KEY: KEY };

describe('diagAuthorized', () => {
  it('accepts only the matching key header when diag is enabled', () => {
    expect(diagAuthorized({ 'x-accord-diag-key': [KEY] }, env)).toBe(true);
    expect(diagAuthorized({ 'X-Accord-Diag-Key': [KEY] }, env)).toBe(true);
    expect(diagAuthorized({ 'x-accord-diag-key': [`${KEY}x`] }, env)).toBe(false);
    expect(diagAuthorized({ 'x-accord-diag-key': ['short'] }, env)).toBe(false);
    expect(diagAuthorized({}, env)).toBe(false);
    expect(diagAuthorized(undefined, env)).toBe(false);
  });

  it('refuses everything when diag is disabled or the key is unset or weak', () => {
    expect(diagAuthorized({ 'x-accord-diag-key': [KEY] }, { ...env, ACCORD_DIAG_ENABLED: 'false' })).toBe(false);
    expect(diagAuthorized({ 'x-accord-diag-key': [''] }, { ACCORD_DIAG_ENABLED: 'true' })).toBe(false);
    expect(diagAuthorized({ 'x-accord-diag-key': ['abc'] }, { ACCORD_DIAG_ENABLED: 'true', ACCORD_DIAG_KEY: 'abc' })).toBe(false);
  });
});
