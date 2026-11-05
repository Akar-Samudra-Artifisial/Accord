import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sql/db', () => ({ run: vi.fn(), select: vi.fn(async () => []) }));

import { shiftScenario } from '../planner/fixtures';
import { sameApproverAllowed } from '../../src/demo/demo-mode';
import {
  applyContract,
  contractLabel,
  createRequest,
  decide,
  MAX_REQUESTS_PER_PROVIDER_PER_HOUR,
  MAX_TITLE_LENGTH,
  normalizeTitle,
  quotedTitle,
  runRound1,
  runRound2,
} from '../../src/negotiation/orchestrator';
import { handleNegotiationEvent, parseNegotiationEvent } from '../../src/negotiation/consumer';
import { MOB, PAY, REQUEST_ID, harness, request, type Harness } from './fakes';

async function negotiated(h: Harness, overrides = {}) {
  await h.store.insertRequest(request({ size: 'L', ...overrides }));
  await runRound1(h.deps, REQUEST_ID);
  await runRound2(h.deps, REQUEST_ID);
  const broker = await h.store.getRound(REQUEST_ID, 2, 'broker');
  return (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
}

describe('createRequest', () => {
  it('stores a negotiating request and enqueues round 1 without touching Jira', async () => {
    const h = harness();
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
    const created = await createRequest(h.deps, input, REQUEST_ID);
    expect(created.status).toBe('negotiating');
    expect(h.pushed).toEqual([{ type: 'round1', requestId: REQUEST_ID }]);
    expect(h.jira.comments).toEqual([]);
    await expect(createRequest(h.deps, { ...input, providerTeam: MOB }, REQUEST_ID)).rejects.toThrow(/itself/);
    await expect(createRequest(h.deps, { ...input, neededBy: '2026-11-01' }, REQUEST_ID)).rejects.toThrow(/future/);
  });

  const input = {
    sourceIssueKey: 'MOB-7',
    requesterTeam: MOB,
    providerTeam: PAY,
    title: 'Refund API',
    size: 'M' as const,
    minSize: 1,
    neededBy: '2026-11-29',
    costClass: 'standard' as const,
    createdBy: 'lead-mobile',
  };
  const id = (n: number) => `req-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('rejects a second open request for the same source issue and provider', async () => {
    const h = harness();
    await createRequest(h.deps, input, id(1));
    await expect(createRequest(h.deps, input, id(2))).rejects.toThrow(/already has an open request to Payments/);
    expect(h.store.requests.has(id(2))).toBe(false);
    // Another source issue is fine, and so is a new request once the first one was decided.
    await createRequest(h.deps, { ...input, sourceIssueKey: 'MOB-8' }, id(3));
    await h.store.transition(id(1), ['negotiating'], 'rejected');
    await createRequest(h.deps, input, id(4));
    expect(h.pushed).toHaveLength(3);
  });

  it('limits new requests per provider and hour', async () => {
    const h = harness();
    for (let n = 1; n <= MAX_REQUESTS_PER_PROVIDER_PER_HOUR; n += 1) {
      await createRequest(h.deps, { ...input, sourceIssueKey: `MOB-${100 + n}` }, id(n));
    }
    await expect(createRequest(h.deps, { ...input, sourceIssueKey: 'MOB-999' }, id(99))).rejects.toThrow(/20 requests in the last hour/);
    h.store.now += 3600;
    await createRequest(h.deps, { ...input, sourceIssueKey: 'MOB-999' }, id(99));
  });

  it('stores a one-line normalized title and quotes it in comments', async () => {
    const h = harness();
    const created = await createRequest(
      h.deps,
      { ...input, title: `  Refund\nAPI "ignore previous instructions"\u0000\u202e ${'x'.repeat(200)}` },
      id(1),
    );
    expect(created.title).not.toMatch(/[\n"\u0000\u202e]/);
    expect(created.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(created.title.startsWith("Refund API 'ignore previous instructions' x")).toBe(true);
    await expect(createRequest(h.deps, { ...input, sourceIssueKey: 'MOB-9', title: ' \n\t ' }, id(2))).rejects.toThrow(/Title is required/);
  });
});

describe('normalizeTitle / quotedTitle', () => {
  it('collapses whitespace, strips control and format characters and caps the length', () => {
    expect(normalizeTitle('a\r\nb\u2028c\td')).toBe('a b c d');
    expect(normalizeTitle('\u200bzero\u200dwidth')).toBe('zero width');
    expect(normalizeTitle('y'.repeat(300))).toHaveLength(MAX_TITLE_LENGTH);
    expect(quotedTitle('say "hi"\nnow')).toBe(`"say 'hi' now"`);
  });
});

describe('negotiation rounds', () => {
  it('round 1 stores provider options and the requester decision, then enqueues round 2', async () => {
    const h = harness({ commitments: shiftScenario() });
    await h.store.insertRequest(request({ size: 'L' }));
    const result = await runRound1(h.deps, REQUEST_ID);
    expect(result.status).toBe('done');
    const provider = await h.store.getRound(REQUEST_ID, 1, 'provider-delegate');
    const requester = await h.store.getRound(REQUEST_ID, 1, 'requester-delegate');
    expect(provider?.status).toBe('done');
    expect(requester?.output).toMatchObject({ decision: { action: 'accept', reason: 'meets-need' }, variationOptionIds: [] });
    expect(h.store.options.map((o) => o.kind)).toEqual(['on-time-with-shift', 'later']);
    // Round input keeps aggregate numbers only (NFR-3).
    expect(provider?.output).toMatchObject({ planner: { commitmentCount: 16, capacity: { pessimistic: 9 } } });
    expect(JSON.stringify([provider?.input, provider?.output])).not.toContain('Ledger cleanup');
    expect(h.pushed).toEqual([{ type: 'round2', requestId: REQUEST_ID }]);
  });

  it('round 2 ranks, recommends, comments and waits for approval', async () => {
    const h = harness({ commitments: shiftScenario() });
    const ranked = await negotiated(h);
    const request = await h.store.getRequest(REQUEST_ID);
    expect(request?.status).toBe('awaiting-approval');
    const recommended = h.store.options.filter((o) => o.recommended);
    expect(recommended.map((o) => o.id)).toEqual([ranked[0]]);
    expect(recommended[0].kind).toBe('on-time-with-shift');
    // Only the source issue: the requester has no permission on the provider issues the option would shift (NFR-3).
    expect(recommended[0].shifted.length).toBeGreaterThan(0);
    expect(h.jira.comments.map((c) => c.issueKey)).toEqual(['MOB-7']);
    expect(h.jira.comments[0].text).toMatch(/Recommended delivery: [A-Z][a-z]{2} \d{1,2}, 2026/);
    // No Jira change other than comments before both leads approve (NFR-2).
    expect(h.jira.created).toEqual([]);
    expect(h.jira.sprintMoves).toEqual([]);
  });

  it('is idempotent when the queue retries rounds', async () => {
    const h = harness({ commitments: shiftScenario() });
    await negotiated(h);
    const optionCount = h.store.options.length;
    const commentCount = h.jira.comments.length;
    expect((await runRound1(h.deps, REQUEST_ID)).status).toBe('skipped');
    expect((await runRound2(h.deps, REQUEST_ID)).status).toBe('skipped');
    expect(h.store.options).toHaveLength(optionCount);
    expect(h.jira.comments).toHaveLength(commentCount);
  });

  it('resumes round 1 after a failure without duplicating options', async () => {
    const h = harness({ commitments: shiftScenario() });
    await h.store.insertRequest(request({ size: 'L' }));
    const originalPush = h.deps.queue.push;
    h.deps.queue.push = async () => {
      throw new Error('queue unavailable');
    };
    const first = await handleNegotiationEvent(h.deps, { type: 'round1', requestId: REQUEST_ID }, 0);
    expect(first.status).toBe('retry');
    h.deps.queue.push = originalPush;
    const second = await handleNegotiationEvent(h.deps, { type: 'round1', requestId: REQUEST_ID }, 1);
    expect(second.status).toBe('done');
    expect(h.store.options.map((o) => o.kind)).toEqual(['on-time-with-shift', 'later']);
  });

  it('marks the request failed after the last attempt', async () => {
    const h = harness();
    await h.store.insertRequest(request());
    h.deps.teams.planningContext = async () => {
      throw new Error('Jira down');
    };
    // Forge allows four retries: retryCount 4 is the fifth and last attempt (MAX_ATTEMPTS = 5).
    expect((await handleNegotiationEvent(h.deps, { type: 'round1', requestId: REQUEST_ID }, 3)).status).toBe('retry');
    const result = await handleNegotiationEvent(h.deps, { type: 'round1', requestId: REQUEST_ID }, 4);
    expect(result.status).toBe('skipped');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('failed');
    expect((await h.store.getRound(REQUEST_ID, 1, 'provider-delegate'))?.status).toBe('failed');
  });

  it('only accepts well-formed queue events', () => {
    expect(parseNegotiationEvent({ type: 'round2', requestId: REQUEST_ID })).toEqual({ type: 'round2', requestId: REQUEST_ID });
    expect(parseNegotiationEvent({ type: 'round3', requestId: REQUEST_ID })).toBeNull();
    expect(parseNegotiationEvent({ type: 'round1', requestId: "x' OR 1=1" })).toBeNull();
    expect(parseNegotiationEvent({ ping: true })).toBeNull();
  });
});

describe('requester delegate variation', () => {
  it('asks for the minimum part earlier when no option meets the need', async () => {
    const h = harness();
    // Needed before the first sprint ends: no room, so only later/decline options.
    await h.store.insertRequest(request({ size: 'M', minSize: 1, neededBy: '2026-11-10' }));
    await runRound1(h.deps, REQUEST_ID);
    const requester = await h.store.getRound(REQUEST_ID, 1, 'requester-delegate');
    const output = requester?.output as { decision: { action: string; variation: unknown }; variationOptionIds: number[] };
    expect(output.decision).toEqual({ action: 'request-variation', variation: { kind: 'earlier-min', days: 2 } });
    expect(output.variationOptionIds.length).toBeGreaterThan(0);
    const variationOptions = h.store.options.filter((o) => o.roundId === requester?.id);
    expect(variationOptions.every((o) => o.trace.some((s) => s.step === 'variation' && s.values.neededByMin === '2026-11-08'))).toBe(true);
    await runRound2(h.deps, REQUEST_ID);
    const broker = await h.store.getRound(REQUEST_ID, 2, 'broker');
    const ranked = (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
    // Duplicate offers from the variation are dropped; at most four options.
    expect(ranked.length).toBeLessThanOrEqual(4);
    expect(new Set(ranked.map((id) => h.store.options.find((o) => o.id === id)?.kind)).size).toBe(ranked.length);
  });

  it('does not ask for a variation without a minimum part', async () => {
    const h = harness();
    await h.store.insertRequest(request({ size: 'M', minSize: null, neededBy: '2026-11-10' }));
    await runRound1(h.deps, REQUEST_ID);
    const requester = await h.store.getRound(REQUEST_ID, 1, 'requester-delegate');
    expect(requester?.output).toMatchObject({ decision: { action: 'accept', reason: 'no-minimum' } });
  });
});

describe('approvals', () => {
  it('rejects decisions from accounts that are not approvers of the chosen side', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-mobile' }),
    ).rejects.toThrow(/not an approver for Payments/);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: undefined }),
    ).rejects.toThrow(/signed-in/);
    expect(h.store.approvals).toEqual([]);
    expect(h.store.auditLog.some((e) => e.action === 'decision-denied' && e.actor === 'lead-mobile')).toBe(true);
  });

  it('does not create a contract when the two leads approve different options', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [first, second] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: first, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    const result = await decide(h.deps, {
      requestId: REQUEST_ID,
      optionId: second,
      side: 'provider',
      decision: 'approve',
      accountId: 'lead-payments',
    });
    expect(result.status).toBe('recorded');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('awaiting-approval');
    expect(h.pushed.filter((e) => e.type === 'apply-contract')).toEqual([]);
    expect((await applyContract(h.deps, REQUEST_ID)).status).toBe('skipped');
    expect(h.store.contracts).toEqual([]);
  });

  it('dual control: by default one account cannot approve for both teams', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' }),
    ).rejects.toThrow(/Dual control/);
    expect(h.store.approvals).toHaveLength(1);
    expect(h.pushed.filter((e) => e.type === 'apply-contract')).toHaveLength(0);
    expect(h.store.auditLog.some((e) => e.action === 'decision-denied' && (e.payload as { rule?: string }).rule === 'dual-control')).toBe(true);
  });

  it('dual control: demo mode off (default) refuses the second approval by the same account without reading other state', async () => {
    const h = harness({ commitments: shiftScenario() });
    let modeReads = 0;
    h.deps.allowSameApprover = async () => {
      modeReads += 1;
      return false;
    };
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    expect(modeReads).toBe(0);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' }),
    ).rejects.toThrow(/Dual control/);
    expect(modeReads).toBe(1);
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('awaiting-approval');
    expect(h.store.auditLog.filter((e) => e.action === 'approved')).toHaveLength(1);
  });

  it('demo mode on: the same account may approve for both teams and the second approval is audited with demoMode', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.deps.allowSameApprover = async () => true;
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    const two = await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' });
    expect(two.status).toBe('agreed');
    const approved = h.store.auditLog.filter((e) => e.action === 'approved').map((e) => (e.payload as { demoMode?: boolean }).demoMode);
    expect(approved).toEqual([undefined, true]);
  });

  it('demo mode on keeps dual control when a team is not an Accord demo project', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.deps.allowSameApprover = ({ requester, provider }) =>
      sameApproverAllowed(
        { enabled: async () => true, demoProjectKeys: async () => ['MOB'] },
        { requester: requester.jiraProjectKey, provider: provider.jiraProjectKey },
      );
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' }),
    ).rejects.toThrow(/Dual control/);
    expect(h.store.auditLog.some((e) => e.action === 'decision-denied' && (e.payload as { rule?: string }).rule === 'dual-control')).toBe(true);
  });

  it('demo mode check failure fails closed: dual control refusal with decision-denied audit', async () => {
    const h = harness({ commitments: shiftScenario() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.deps.allowSameApprover = ({ requester, provider }) =>
      sameApproverAllowed(
        {
          enabled: async () => {
            throw new Error('SQL unavailable');
          },
          demoProjectKeys: async () => ['MOB', 'PAY'],
        },
        { requester: requester.jiraProjectKey, provider: provider.jiraProjectKey },
      );
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' }),
    ).rejects.toThrow(/Dual control/);
    expect(h.store.auditLog.some((e) => e.action === 'decision-denied' && (e.payload as { rule?: string }).rule === 'dual-control')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('demo mode on does not mark approvals by two different leads', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.deps.allowSameApprover = async () => true;
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
    expect(h.store.auditLog.filter((e) => e.action === 'approved').every((e) => !('demoMode' in (e.payload as object)))).toBe(true);
  });

  it('enqueues apply-contract once when both sides approve the same option, also when one person leads both teams (demo switch)', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.deps.allowSameApprover = async () => true;
    h.deps.teams.approvers = async () => ['lead-both'];
    const [best] = await negotiated(h);
    const one = await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-both' });
    expect(one.status).toBe('waiting-for-other-side');
    const two = await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' });
    expect(two.status).toBe('agreed');
    expect(h.store.approvals.map((a) => a.teamId)).toEqual([MOB.id, PAY.id]);
    expect(h.pushed.filter((e) => e.type === 'apply-contract')).toHaveLength(1);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-both' }),
    ).rejects.toThrow(/approved/);
  });

  it('a rejection with a reason ends the negotiation', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'reject', accountId: 'lead-payments' }),
    ).rejects.toThrow(/reason/);
    const result = await decide(h.deps, {
      requestId: REQUEST_ID,
      optionId: best,
      side: 'provider',
      decision: 'reject',
      reason: 'Ledger cleanup cannot move this quarter',
      accountId: 'lead-payments',
    });
    expect(result.status).toBe('rejected');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('rejected');
  });

  it('refuses an approval when the approver lacks the Jira permissions for their side, and audits the check', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    const asked: Array<{ scope: unknown; permissions: readonly string[] }> = [];
    h.deps.userPermissions = async (scope, permissions) => {
      asked.push({ scope, permissions });
      // The Payments lead may browse and comment but not create or schedule issues.
      return new Set(permissions.filter((permission) => !['CREATE_ISSUES', 'SCHEDULE_ISSUES'].includes(permission)));
    };
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' }),
    ).rejects.toThrow(/missing CREATE_ISSUES, SCHEDULE_ISSUES on project PAY/);
    expect(asked).toEqual([{ scope: { projectKey: 'PAY' }, permissions: ['CREATE_ISSUES', 'SCHEDULE_ISSUES'] }]);
    expect(h.store.approvals).toEqual([]);
    const denied = h.store.auditLog.find((e) => e.action === 'decision-denied');
    expect(denied?.payload).toMatchObject({ rule: 'jira-permissions', missing: ['CREATE_ISSUES', 'SCHEDULE_ISSUES'] });

    // Requester side: LINK_ISSUES + ADD_COMMENTS on the source issue; granted → recorded with the check.
    const ok = await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    expect(ok.status).toBe('waiting-for-other-side');
    expect(asked[1]).toEqual({ scope: { issueKey: 'MOB-7' }, permissions: ['LINK_ISSUES', 'ADD_COMMENTS'] });
    const approved = h.store.auditLog.find((e) => e.action === 'approved');
    expect(approved?.payload).toMatchObject({ permissions: { granted: ['LINK_ISSUES', 'ADD_COMMENTS'], missing: [] } });
  });

  it('fails closed when the permission check itself fails', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    h.deps.userPermissions = async () => {
      throw new Error('Jira unavailable');
    };
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' }),
    ).rejects.toThrow(/missing LINK_ISSUES, ADD_COMMENTS on MOB-7/);
    expect(h.store.approvals).toEqual([]);
  });

  it('a rejection needs no Jira permission check (nothing changes in Jira)', async () => {
    const h = harness({ commitments: shiftScenario() });
    const [best] = await negotiated(h);
    h.deps.userPermissions = async () => new Set();
    const result = await decide(h.deps, {
      requestId: REQUEST_ID,
      optionId: best,
      side: 'provider',
      decision: 'reject',
      reason: 'No room',
      accountId: 'lead-payments',
    });
    expect(result.status).toBe('rejected');
  });

  it('refuses options that are not on the deal sheet', async () => {
    const h = harness({ commitments: shiftScenario() });
    await negotiated(h);
    await expect(
      decide(h.deps, { requestId: REQUEST_ID, optionId: 9999, side: 'requester', decision: 'approve', accountId: 'lead-mobile' }),
    ).rejects.toThrow(/not on this deal sheet/);
  });
});

describe('applyContract', () => {
  async function approved(h: Harness) {
    const [best] = await negotiated(h);
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
    await decide(h.deps, { requestId: REQUEST_ID, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
    return best;
  }

  it('creates the deliverable, link, sprint moves, comments, contract, edge and audit trail', async () => {
    const h = harness({ commitments: shiftScenario() });
    const best = await approved(h);
    const commentsBefore = h.jira.comments.length;
    const result = await applyContract(h.deps, REQUEST_ID);
    expect(result.status).toBe('done');
    expect(h.jira.created).toEqual([
      { projectKey: 'PAY', key: 'PAY-100', labels: ['accord', contractLabel(REQUEST_ID)], dueDate: '2026-11-29' },
    ]);
    expect(h.jira.links).toEqual([{ blocker: 'PAY-100', blocked: 'MOB-7' }]);
    expect(h.jira.sprintMoves).toEqual([{ sprintId: 's3', keys: ['PAY-1', 'PAY-11', 'PAY-2', 'PAY-3'] }]);
    expect(h.jira.comments.slice(commentsBefore).map((c) => c.issueKey)).toEqual(['MOB-7', 'PAY-100']);
    expect(h.store.contracts).toMatchObject([{ optionId: best, deliverableIssueKey: 'PAY-100', status: 'on-track' }]);
    expect(h.store.edges).toEqual([{ contractId: h.store.contracts[0].id, from: MOB.id, to: PAY.id }]);
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('contracted');
    const applied = h.store.auditLog.find((e) => e.action === 'contract-applied');
    expect(applied?.payload).toMatchObject({ as: 'app', approvedBy: ['lead-mobile', 'lead-payments'] });
    expect(h.monitorRuns).toEqual([PAY.id]);
  });

  it('keeps the contract applied when the monitor enqueue fails', async () => {
    const h = harness({ commitments: shiftScenario() });
    await approved(h);
    h.deps.monitor.evaluateProvider = async () => {
      throw new Error('queue down');
    };
    expect((await applyContract(h.deps, REQUEST_ID)).status).toBe('done');
    expect(h.store.auditLog.find((e) => e.action === 'monitor-enqueue-failed')?.payload).toEqual({ error: 'queue down' });
  });

  it('does not duplicate anything when retried, even after a crash right after creating the issue', async () => {
    const h = harness({ commitments: shiftScenario() });
    await approved(h);
    h.jira.failAfterCreate = true;
    const first = await handleNegotiationEvent(h.deps, { type: 'apply-contract', requestId: REQUEST_ID }, 0);
    expect(first.status).toBe('retry');
    await applyContract(h.deps, REQUEST_ID);
    const snapshot = {
      created: h.jira.created.length,
      links: h.jira.links.length,
      moves: h.jira.sprintMoves.length,
      comments: h.jira.comments.length,
    };
    expect((await applyContract(h.deps, REQUEST_ID)).status).toBe('skipped');
    // Force a re-run of every step even though the request is already contracted.
    await h.store.transition(REQUEST_ID, ['contracted'], 'approved');
    await applyContract(h.deps, REQUEST_ID);
    expect(snapshot).toEqual({ created: 1, links: 1, moves: 1, comments: h.jira.comments.length });
    expect(h.jira.created).toHaveLength(1);
    expect(h.jira.links).toHaveLength(1);
    expect(h.jira.sprintMoves).toHaveLength(1);
    expect(h.jira.comments).toHaveLength(snapshot.comments);
    expect(h.store.contracts).toHaveLength(1);
    expect(h.store.edges).toHaveLength(1);
    expect(h.store.contracts[0].deliverableIssueKey).toBe('PAY-100');
  });

  it('moves work planned for a projected sprint to the backlog', async () => {
    const h = harness({ commitments: shiftScenario() });
    const best = await approved(h);
    // Same option, but the target sprint only exists in the planner horizon.
    const option = h.store.options.find((o) => o.id === best);
    if (!option) throw new Error('option missing');
    option.shifted = [{ key: 'PAY-1', costClass: 'intangible', toSprintId: 'projected-3' }];
    await applyContract(h.deps, REQUEST_ID);
    expect(h.jira.backlogMoves).toEqual([['PAY-1']]);
    expect(h.jira.sprintMoves).toEqual([]);
  });
});
