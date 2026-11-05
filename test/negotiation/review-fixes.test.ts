import { describe, expect, it } from 'vitest';
import { shiftScenario } from '../planner/fixtures';
import {
  applyContract,
  createRequest,
  decide,
  DELIVERABLE_SEARCH_GRACE_SECONDS,
  retryRequest,
  runRound1,
  runRound2,
  STUCK_AFTER_SECONDS,
} from '../../src/negotiation/orchestrator';
import { handleNegotiationEvent } from '../../src/negotiation/consumer';
import { redact, redactSources } from '../../src/negotiation/views';
import { isBlocksFrom } from '../../src/jira/issues';
import type { RequestStatus } from '../../src/negotiation/types';
import type { TraceStep } from '../../src/planner';
import { MOB, PAY, REQUEST_ID, harness, request, type Harness } from './fakes';

async function negotiated(h: Harness) {
  await h.store.insertRequest(request({ size: 'L' }));
  await runRound1(h.deps, REQUEST_ID);
  await runRound2(h.deps, REQUEST_ID);
  const broker = await h.store.getRound(REQUEST_ID, 2, 'broker');
  return (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
}

const approve = (h: Harness, optionId: number, side: 'requester' | 'provider') =>
  decide(h.deps, {
    requestId: REQUEST_ID,
    optionId,
    side,
    decision: 'approve',
    accountId: side === 'requester' ? 'lead-mobile' : 'lead-payments',
  });

async function approved(h: Harness) {
  const [best] = await negotiated(h);
  await approve(h, best, 'requester');
  await approve(h, best, 'provider');
  return best;
}

describe('round 2 resume (broker done, status change lost)', () => {
  it('moves a request stuck in negotiating to awaiting-approval without new comments', async () => {
    const h = harness({ commitments: shiftScenario() });
    await negotiated(h);
    // Simulate the crash between broker finishRound and the status transition.
    await h.store.transition(REQUEST_ID, ['awaiting-approval'], 'negotiating');
    const comments = h.jira.comments.length;
    const result = await runRound2(h.deps, REQUEST_ID);
    expect(result.status).toBe('done');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('awaiting-approval');
    expect(h.jira.comments).toHaveLength(comments);
  });
});

describe('reject vs approve races', () => {
  it('an approval that loses against a concurrent rejection is not recorded', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    await approve(h, best, 'requester');
    const original = h.store.addApproval.bind(h.store);
    h.store.addApproval = async (approval, whenStatus) => {
      await h.store.transition(REQUEST_ID, ['awaiting-approval'], 'rejected');
      return original(approval, whenStatus);
    };
    await expect(approve(h, best, 'provider')).rejects.toThrow(/changed to rejected/);
    expect(h.store.approvals.filter((a) => a.teamId === PAY.id)).toHaveLength(0);
    expect(h.pushed.filter((e) => e.type === 'apply-contract')).toHaveLength(0);
  });

  it('a rejection that loses against the second approval reports the real status, not rejected', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    const original = h.store.transition.bind(h.store);
    h.store.transition = async (id: string, from: readonly RequestStatus[], to: RequestStatus) => {
      if (to === 'rejected') await original(id, ['awaiting-approval'], 'approved');
      return original(id, from, to);
    };
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'reject', reason: 'No', accountId: 'lead-payments' }),
    ).rejects.toThrow(/changed to approved/);
    expect(h.store.approvals.filter((a) => a.decision === 'reject')).toHaveLength(0);
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('approved');
  });

  it('a rejection after agreement is refused', async () => {
    const h = harness({ commitments: shiftScenario() });
    const best = await approved(h);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'reject', reason: 'Late', accountId: 'lead-payments' }),
    ).rejects.toThrow(/approved/);
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('approved');
  });

  it('only one of two concurrent final approvals enqueues apply-contract', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    await approve(h, best, 'requester');
    const original = h.store.transition.bind(h.store);
    h.store.transition = async (id: string, from: readonly RequestStatus[], to: RequestStatus) => {
      // The other caller wins awaiting-approval → approved first.
      if (to === 'approved') await original(id, from, to);
      return original(id, from, to);
    };
    const result = await approve(h, best, 'provider');
    expect(result.status).toBe('agreed');
    expect(h.pushed.filter((e) => e.type === 'apply-contract')).toHaveLength(0);
  });
});

describe('contract option', () => {
  it('is fixed at agreement and used by applyContract even if approvals change later', async () => {
    const h = harness({ commitments: shiftScenario() });
    const best = await approved(h);
    expect(h.store.contracts).toMatchObject([{ optionId: best }]);
    const other = h.store.options.find((o) => o.id !== best && o.kind !== 'reject');
    if (!other) throw new Error('no second option');
    for (const teamId of [MOB.id, PAY.id]) {
      h.store.approvals.push({ id: 999 + h.store.approvals.length, requestId: REQUEST_ID, optionId: other.id, teamId, actorAccountId: 'x', decision: 'approve', reason: null, createdAt: '' });
    }
    await applyContract(h.deps, REQUEST_ID);
    const chosen = h.store.options.find((o) => o.id === best);
    expect(h.jira.created[0].dueDate).toBe(chosen?.dateRange.max);
    expect(h.jira.sprintMoves).toEqual([
      { sprintId: 's2', keys: ['PAY-100'] },
      { sprintId: 's3', keys: ['PAY-1', 'PAY-11', 'PAY-2', 'PAY-3'] },
    ]);
  });
});

describe('deliverable idempotency', () => {
  it('does not create a second deliverable while Jira search has not indexed the first one', async () => {
    const h = harness({ commitments: shiftScenario() });
    await approved(h);
    h.jira.failAfterCreate = true;
    h.jira.searchLag = true;
    expect((await handleNegotiationEvent(h.deps, { type: 'apply-contract', requestId: REQUEST_ID }, 0)).status).toBe('retry');
    h.store.now += 10;
    expect((await handleNegotiationEvent(h.deps, { type: 'apply-contract', requestId: REQUEST_ID }, 1)).status).toBe('retry');
    expect(h.jira.created).toHaveLength(1);
    h.jira.searchLag = false;
    h.store.now += DELIVERABLE_SEARCH_GRACE_SECONDS;
    expect((await handleNegotiationEvent(h.deps, { type: 'apply-contract', requestId: REQUEST_ID }, 2)).status).toBe('done');
    expect(h.jira.created).toHaveLength(1);
    expect(h.store.contracts[0].deliverableIssueKey).toBe('PAY-100');
    expect(h.store.auditLog.filter((e) => e.action === 'contract:deliverable-intent')).toHaveLength(1);
  });

  it('comments at most once, also when posting failed', async () => {
    const h = harness({ commitments: shiftScenario() });
    await approved(h);
    h.jira.failComment = true;
    await applyContract(h.deps, REQUEST_ID);
    h.jira.failComment = false;
    await h.store.transition(REQUEST_ID, ['contracted'], 'approved');
    const before = h.jira.comments.length;
    await applyContract(h.deps, REQUEST_ID);
    expect(h.jira.comments).toHaveLength(before);
    expect(h.store.auditLog.filter((e) => e.action === 'comment-failed')).toHaveLength(2);
  });
});

describe('planning data', () => {
  it('is loaded once per round 1 job, also when the requester asks for a variation', async () => {
    const h = harness();
    await h.store.insertRequest(request({ size: 'M', minSize: 1, neededBy: '2026-11-10' }));
    await runRound1(h.deps, REQUEST_ID);
    const requester = await h.store.getRound(REQUEST_ID, 1, 'requester-delegate');
    expect(requester?.output).toMatchObject({ decision: { action: 'request-variation' } });
    expect(h.planningCalls.count).toBe(1);
  });
});

describe('orphan requests and retry', () => {
  const input = {
    sourceIssueKey: 'MOB-7',
    requesterTeam: MOB,
    providerTeam: PAY,
    title: 'Refund API',
    size: 'M' as const,
    minSize: 1,
    neededBy: '2026-11-29',
    costClass: 'fixed-date' as const,
    createdBy: 'lead-mobile',
  };

  it('marks the request failed when round 1 cannot be enqueued, and a lead can retry it', async () => {
    const h = harness();
    const push = h.deps.queue.push;
    h.deps.queue.push = async () => {
      throw new Error('queue unavailable');
    };
    await expect(createRequest(h.deps, input, REQUEST_ID)).rejects.toThrow(/Retry negotiation/);
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('failed');
    expect(h.store.auditLog.some((e) => e.action === 'round1-enqueue-failed')).toBe(true);
    h.deps.queue.push = push;
    await expect(retryRequest(h.deps, REQUEST_ID, 'someone-else')).rejects.toThrow(/Only the requester/);
    const result = await retryRequest(h.deps, REQUEST_ID, 'lead-payments');
    expect(result.status).toBe('done');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('negotiating');
    expect(h.pushed).toEqual([{ type: 'round1', requestId: REQUEST_ID }]);
  });

  it('re-queues a request stuck in negotiating only after the idle period', async () => {
    const h = harness();
    await createRequest(h.deps, input, REQUEST_ID);
    await expect(retryRequest(h.deps, REQUEST_ID, 'lead-mobile')).rejects.toThrow(/still working/);
    h.store.now += STUCK_AFTER_SECONDS;
    await retryRequest(h.deps, REQUEST_ID, 'lead-mobile');
    expect(h.pushed).toEqual([
      { type: 'round1', requestId: REQUEST_ID },
      { type: 'round1', requestId: REQUEST_ID },
    ]);
  });

  it('retries apply-contract for a failed request that both leads approved', async () => {
    const h = harness({ commitments: shiftScenario() });
    await approved(h);
    await h.store.transition(REQUEST_ID, ['approved'], 'failed');
    await retryRequest(h.deps, REQUEST_ID, 'lead-mobile');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('approved');
    expect(h.pushed.at(-1)).toEqual({ type: 'apply-contract', requestId: REQUEST_ID });
  });
});

describe('redaction', () => {
  const trace: TraceStep[] = [
    { step: 'shift', text: '', values: { key: 'PAY-1', summary: 'Ledger cleanup' }, sources: [{ type: 'issue', ref: 'PAY-1' }] },
  ];

  it('hides only the exact key, never a longer key with the same prefix', () => {
    const visible = new Set(['PAY-11']);
    expect(redact('Move PAY-1 (Ledger cleanup), PAY-11 and XPAY-1; then PAY-1.', trace, visible)).toBe(
      'Move a restricted issue, PAY-11 and XPAY-1; then a restricted issue.',
    );
    expect(redact('PAY-1', trace, null)).toBe('PAY-1');
  });

  it('redacts issue sources as well', () => {
    const sources: TraceStep['sources'] = [
      { type: 'issue', ref: 'PAY-1' },
      { type: 'issue', ref: 'PAY-11' },
      { type: 'sprint', ref: 'PAY Sprint 2' },
    ];
    expect(redactSources(sources, new Set(['PAY-11']))).toEqual([
      { type: 'issue', ref: 'a restricted issue' },
      { type: 'issue', ref: 'PAY-11' },
      { type: 'sprint', ref: 'PAY Sprint 2' },
    ]);
  });
});

describe('Blocks link direction', () => {
  it('only counts a link read from the blocker whose outward issue is the blocked issue', () => {
    const type = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
    expect(isBlocksFrom({ type, outwardIssue: { key: 'MOB-1' } }, 'MOB-1')).toBe(true);
    expect(isBlocksFrom({ type, inwardIssue: { key: 'MOB-1' } }, 'MOB-1')).toBe(false);
    expect(isBlocksFrom({ type: { name: 'Relates' }, outwardIssue: { key: 'MOB-1' } }, 'MOB-1')).toBe(false);
  });
});
