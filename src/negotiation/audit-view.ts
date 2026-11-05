import type { AuditEntry } from './store';

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
      return `${text(p.side)} side approved ${label ?? 'an option'}`;
    }
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
      return `Agreed ${text(agreed.min)} to ${text(agreed.max)}`;
    }
    case 'status-changed':
      return `${text(p.from)} → ${text(p.to)}; projected ${text(p.projectedDate) || 'beyond the planning horizon'}, agreed by ${text(p.agreedDateMax)}`;
    default:
      return '';
  }
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
