import { describe, expect, it } from 'vitest';
import { auditLabel, auditTimeline, toAuditRow, type AuditViewContext } from '../../src/negotiation/audit-view';
import type { AuditEntry } from '../../src/negotiation/store';

const context: AuditViewContext = {
  viewerAccountId: 'me',
  approverIds: new Set(['lead-mobile', 'me']),
  subjectOf: () => 'Refund API',
};

const entry = (action: string, actor: string | null, payload: unknown = null): AuditEntry => ({
  id: 1,
  entityType: 'contract',
  entityId: '2',
  action,
  actorAccountId: actor,
  payload,
  createdAt: '2026-11-05 10:00:00',
});

describe('auditTimeline', () => {
  const at = (id: number, action: string, createdAt: string): AuditEntry => ({ ...entry(action, null), id, createdAt });
  // one-atlas: ids from two TiDB ranges (30xxx, 60xxx) are not chronological.
  const cleaned = at(30165, 'demo-cleaned', '2026-11-05 10:20:42');

  it('shows the latest clean first right after a clean', () => {
    expect(auditTimeline([], cleaned, 50).map((e) => e.id)).toEqual([30165]);
  });

  it('orders by time, not id, and keeps the clean below what followed it', () => {
    const recent = [
      at(30170, 'contract-applied', '2026-11-05 10:30:05'),
      at(60160, 'approved', '2026-11-05 10:30:01'),
      at(30166, 'created', '2026-11-05 10:20:42'),
    ];
    expect(auditTimeline(recent, cleaned, 50).map((e) => e.action)).toEqual(['contract-applied', 'approved', 'created', 'demo-cleaned']);
    expect(auditTimeline(recent, cleaned, 2).map((e) => e.action)).toEqual(['contract-applied', 'approved']);
  });
});

describe('audit rows', () => {
  it('describes a monitor status change with numbers from the payload', () => {
    const row = toAuditRow(
      entry('status-changed', null, { from: 'on-track', to: 'at-risk', projectedDate: '2026-12-12', agreedDateMax: '2026-11-28' }),
      context,
    );
    expect(row).toEqual({
      id: 1,
      at: '2026-11-05 10:00:00',
      subject: 'Refund API',
      action: 'Contract status changed',
      actor: 'Accord app',
      summary: 'on-track → at-risk; projected Dec 12, 2026, agreed by Nov 28, 2026',
    });
  });

  it('never exposes account ids or moved issue keys', () => {
    expect(toAuditRow(entry('approved', 'me', { side: 'provider', optionId: 7 }), context).actor).toBe('You');
    expect(toAuditRow(entry('approved', 'lead-mobile'), context).actor).toBe('A team approver');
    const stranger = toAuditRow(entry('decision-denied', 'acc-123'), context);
    expect(stranger.actor).toBe('Another user');
    const shift = toAuditRow(entry('contract:shift', null, { moved: { '4': ['PAY-5', 'PAY-6'] }, backlog: ['PAY-9'] }), context);
    expect(shift.summary).toBe('2 issue(s) moved to a later sprint, 1 to the backlog');
    expect(JSON.stringify([stranger, shift])).not.toMatch(/acc-123|PAY-5|PAY-9/);
  });

  it('names the approved option with its date range instead of the option id', () => {
    const labelled: AuditViewContext = { ...context, optionLabel: (id) => (id === 4 ? '"On time with a shift", 2026-11-20 to 2026-11-28' : null) };
    expect(toAuditRow(entry('approved', 'me', { side: 'provider', optionId: 4 }), labelled).summary).toBe(
      'provider side approved "On time with a shift", 2026-11-20 to 2026-11-28',
    );
    expect(toAuditRow(entry('approved', 'me', { side: 'requester', optionId: 9 }), labelled).summary).toBe('requester side approved an option');
  });

  it('labels step markers generically', () => {
    expect(auditLabel('notify:1:PAY-13')).toBe('Monitor notification posted');
    expect(auditLabel('comment:contract:MOB-2')).toBe('Jira comment posted');
    expect(auditLabel('round2-failed')).toBe('Background step failed');
  });
});
