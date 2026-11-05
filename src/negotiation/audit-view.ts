import { formatDate, formatDateRange } from '../format/dates';
import type { AuditEntry } from './store';

/** Contact names stored in an `escalated` audit payload (FR-15); never account ids. */
export function escalatedNames(payload: unknown): string[] {
  const contacts = payload && typeof payload === 'object' ? (payload as { contacts?: unknown }).contacts : undefined;
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((contact) => (contact && typeof contact === 'object' ? (contact as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

/**
 * Audit tab order: newest first by time (audit ids are not chronological in Forge SQL), the latest
 * `demo-cleaned` entry included, at most `limit` entries.
 */
export function auditTimeline(recent: readonly AuditEntry[], cleaned: AuditEntry | null, limit: number): AuditEntry[] {
  const entries = cleaned ? [...recent.filter((entry) => entry.id !== cleaned.id), cleaned] : [...recent];
  // Stable sort: entries in the same second keep the query order, the clean stays below what followed it.
  return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, limit);
}

/** One row of the Audit tab: only safe, human-readable fields (no raw account ids or issue lists). */
export interface AuditRow {
  id: number;
  at: string;
  subject: string;
  action: string;
  actor: string;
  summary: string;
}

export interface AuditViewContext {
  viewerAccountId: string | undefined;
  /** Charter approvers and project leads of all teams. */
  approverIds: ReadonlySet<string>;
  /** Request title for `request` entries, contract title for `contract` entries. */
  subjectOf: (entry: AuditEntry) => string;
  /** Option name and date range for an approved option id (e.g. "On time, 2026-11-20 to 2026-11-28"). */
  optionLabel?: (optionId: number) => string | null;
}

const LABELS: Record<string, string> = {
  created: 'Request created',
  'options-proposed': 'Options proposed',
  'deal-sheet-ready': 'Deal sheet ready',
  approved: 'Option approved',
  rejected: 'Request rejected',
  'decision-denied': 'Decision refused',
  'retry-requested': 'Retry requested',
  'contract:deliverable-intent': 'Creating the deliverable issue',
  'deliverable-created': 'Deliverable issue created',
  'link-created': 'Blocks link created',
  'contract:shift': 'Issues moved to make room',
  'contract-applied': 'Contract in effect',
  'status-changed': 'Contract status changed',
  'comment-failed': 'Jira comment failed',
  'renegotiation-opened': 'Renegotiation opened',
  'renegotiation-skipped': 'Renegotiation not opened',
  'renegotiation-cancelled': 'Renegotiation cancelled',
  'demo-cleaned': 'Demo data cleaned',
  'demo-mode-enabled': 'Demo mode turned on',
  'demo-mode-disabled': 'Demo mode turned off',
  'contract:due-date': 'Deliverable due date moved',
  'contract-superseded': 'Contract superseded',
  cancelled: 'Request cancelled',
  escalated: 'Escalated',
  'escalation-skipped': 'Escalation not possible',
  'suggestion-created': 'Request suggested from a Jira link',
  'suggestion-dismissed': 'Suggestion dismissed',
  'suggestion-converted': 'Suggestion turned into a request',
};

const record = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

export function auditLabel(action: string): string {
  if (LABELS[action]) return LABELS[action];
  if (action.startsWith('comment:')) return 'Jira comment posted';
  if (action.startsWith('notify:')) return 'Monitor notification posted';
  if (action.endsWith('-failed')) return 'Background step failed';
  return action.replace(/[-:]/g, ' ');
}

function actorLabel(actor: string | null, context: AuditViewContext): string {
  if (actor === null) return 'Accord app';
  // The diagnostics trigger was removed in 1.0.0; development audit rows written by it still carry this actor.
  if (actor === 'diag-webtrigger') return 'Accord diagnostics';
  if (context.viewerAccountId && actor === context.viewerAccountId) return 'You';
  return context.approverIds.has(actor) ? 'A team approver' : 'Another user';
}

function summaryOf(entry: AuditEntry, context: AuditViewContext): string {
  const p = record(entry.payload);
  switch (entry.action) {
    case 'approved': {
      const optionId = Number(p.optionId);
      const label = Number.isInteger(optionId) ? context.optionLabel?.(optionId) : null;
      const demo = p.demoMode === true ? ' (demo mode: same approver as the other side)' : '';
      return `${text(p.side)} side approved ${label ?? 'an option'}${demo}`;
    }
    case 'demo-mode-enabled':
      return 'One person may approve for both teams (dual control off, for evaluation only)';
    case 'demo-mode-disabled':
      return 'Dual control on: each team needs its own approver';
    case 'rejected':
      return `${text(p.side)} side rejected${p.reason ? `: ${text(p.reason).slice(0, 120)}` : ''}`;
    case 'decision-denied':
      return p.rule === 'dual-control' ? 'Dual control: the same person cannot approve for both teams' : 'Not an approver for that team';
    case 'contract:shift': {
      const moved = Object.values(record(p.moved)).reduce<number>((sum, keys) => sum + (Array.isArray(keys) ? keys.length : 0), 0);
      const backlog = Array.isArray(p.backlog) ? p.backlog.length : 0;
      return `${moved} issue(s) moved to a later sprint, ${backlog} to the backlog`;
    }
    case 'contract-applied': {
      const agreed = record(p.agreed);
      const reused = p.deliverableCreated === false && text(p.deliverable) ? `; linked existing ${text(p.deliverable)}` : '';
      return `Agreed ${formatDateRange(text(agreed.min), text(agreed.max))}${reused}`;
    }
    case 'renegotiation-opened':
      return text(p.note);
    case 'escalated': {
      const names = escalatedNames(p);
      return names.length ? `Escalated to ${names.join(', ')} after the request was ${text(p.trigger)}` : '';
    }
    case 'cancelled':
      return text(p.reason).slice(0, 120);
    case 'renegotiation-cancelled': {
      const names = escalatedNames({ contacts: p.approvedBy });
      return `${text(p.reason).slice(0, 120)}${names.length ? `; already approved by ${names.join(', ')}` : ''}`;
    }
    case 'demo-cleaned':
      return text(p.summary).slice(0, 200);
    case 'status-changed':
      return `${text(p.from)} → ${text(p.to)}; projected ${formatDate(text(p.projectedDate), 'beyond the planning horizon')}, agreed by ${formatDate(text(p.agreedDateMax))}`;
    default:
      return '';
  }
}

const KEY_IN_TEXT = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]*(?![0-9])/g;

/** Issue keys named in audit summaries (deliverables, notes, reasons); checked against the viewer's browse permission. */
export function auditIssueKeys(rows: readonly AuditRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.summary.match(KEY_IN_TEXT) ?? []))];
}

export function toAuditRow(entry: AuditEntry, context: AuditViewContext): AuditRow {
  return {
    id: entry.id,
    at: entry.createdAt,
    subject: context.subjectOf(entry),
    action: auditLabel(entry.action),
    actor: actorLabel(entry.actorAccountId, context),
    summary: summaryOf(entry, context),
  };
}
