import { describe, expect, it } from 'vitest';
import { shiftScenario } from '../planner/fixtures';
import {
  applyContract,
  cancelUndecidedRenegotiations,
  decide,
  escalate,
  openRenegotiation,
  retryEscalations,
  runRound1,
  runRound2,
  type RenegotiationTrigger,
} from '../../src/negotiation/orchestrator';
import { handleNegotiationEvent } from '../../src/negotiation/consumer';
import { APP_CREATOR } from '../../src/negotiation/types';
import { buildDealSheet, renegotiationContext } from '../../src/negotiation/views';
import { formatDate } from '../../src/format/dates';
import { MOB, PAY, REQUEST_ID, harness, request, type Harness } from './fakes';

const RENEGOTIATION_ID = 'req-00000000-0000-4000-8000-0000000000aa';

/** Contracted parent request with deliverable PAY-100 (agreed by Nov 29, 2026). */
async function contracted(h: Harness) {
  await h.store.insertRequest(request({ size: 'L' }));
  await runRound1(h.deps, REQUEST_ID);
  await runRound2(h.deps, REQUEST_ID);
  await approveBest(h, REQUEST_ID);
  await applyContract(h.deps, REQUEST_ID);
  const contract = await h.store.getContract(REQUEST_ID);
  if (!contract) throw new Error('parent contract missing');
  await h.store.setContractStatus(REQUEST_ID, 'at-risk');
  return { ...contract, status: 'at-risk' as const, projectedDate: '2026-12-12' };
}

async function approveBest(h: Harness, requestId: string) {
  const broker = await h.store.getRound(requestId, 2, 'broker');
  const [best] = (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
  await decide(h.deps, { requestId, optionId: best, side: 'requester', decision: 'approve', accountId: 'lead-mobile' });
  await decide(h.deps, { requestId, optionId: best, side: 'provider', decision: 'approve', accountId: 'lead-payments' });
  return best;
}

async function trigger(h: Harness, episode = 1): Promise<RenegotiationTrigger> {
  const contract = await contracted(h);
  const parent = await h.store.getRequest(REQUEST_ID);
  if (!parent) throw new Error('parent request missing');
  return { contract, request: parent, projectedDate: '2026-12-12', episode };
}

describe('openRenegotiation (FR-14)', () => {
  it('opens one renegotiation as the app with the projected date in the note', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    const result = await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    expect(result).toMatchObject({ status: 'opened', requestId: RENEGOTIATION_ID });
    expect(await h.store.getRequest(RENEGOTIATION_ID)).toMatchObject({
      sourceIssueKey: 'MOB-7',
      providerTeamId: PAY.id,
      requesterTeamId: MOB.id,
      status: 'negotiating',
      createdBy: APP_CREATOR,
    });
    expect(h.pushed.at(-1)).toEqual({ type: 'round1', requestId: RENEGOTIATION_ID });
    const opened = h.store.auditLog.filter((e) => e.action === 'renegotiation-opened');
    expect(opened).toHaveLength(1);
    expect(opened[0].actor).toBeNull();
    expect(opened[0].payload).toMatchObject({
      as: 'app',
      parentRequestId: REQUEST_ID,
      note: 'Renegotiation: contract PAY-100 → MOB-7 at risk; projected finish Dec 12, 2026',
    });
    expect(h.store.auditLog.find((e) => e.entityId === RENEGOTIATION_ID && e.action === 'created')?.actor).toBeNull();
  });

  it('is idempotent: the same episode or an open renegotiation never opens a second one', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    const again = await openRenegotiation(h.deps, input, 'req-00000000-0000-4000-8000-0000000000bb');
    const nextEpisode = await openRenegotiation(h.deps, { ...input, episode: 2 }, 'req-00000000-0000-4000-8000-0000000000cc');
    expect(again).toMatchObject({ status: 'exists', requestId: RENEGOTIATION_ID });
    expect(nextEpisode).toMatchObject({ status: 'exists', requestId: RENEGOTIATION_ID });
    expect([...h.store.requests.values()].filter((r) => r.createdBy === APP_CREATOR)).toHaveLength(1);
    expect(h.store.auditLog.filter((e) => e.action === 'renegotiation-opened')).toHaveLength(1);
  });

  it('negotiates through the same rounds, comments once, and the applied contract supersedes the old one', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    const commentsBefore = h.jira.comments.length;
    await runRound1(h.deps, RENEGOTIATION_ID);
    await runRound2(h.deps, RENEGOTIATION_ID);
    expect((await h.store.getRequest(RENEGOTIATION_ID))?.status).toBe('awaiting-approval');
    expect((await h.store.listOptions(RENEGOTIATION_ID)).length).toBeGreaterThan(0);
    const opened = h.jira.comments.slice(commentsBefore);
    expect(opened).toHaveLength(1);
    expect(opened[0].text).toContain('opened a renegotiation');

    await approveBest(h, RENEGOTIATION_ID);
    const createdBefore = h.jira.created.length;
    expect((await applyContract(h.deps, RENEGOTIATION_ID)).status).toBe('done');
    // Same deliverable, new due date, no second issue.
    expect(h.jira.created).toHaveLength(createdBefore);
    expect(await h.store.getContract(RENEGOTIATION_ID)).toMatchObject({ deliverableIssueKey: 'PAY-100', status: 'on-track' });
    expect(h.jira.dueDates).toHaveLength(1);
    expect(h.jira.dueDates[0].issueKey).toBe('PAY-100');
    expect((await h.store.getContract(REQUEST_ID))?.status).toBe('superseded');
    expect(h.store.auditLog.filter((e) => e.action === 'contract-superseded')).toHaveLength(1);

    // Retry: nothing twice.
    await applyContract(h.deps, RENEGOTIATION_ID);
    expect(h.jira.dueDates).toHaveLength(1);
    expect(h.store.auditLog.filter((e) => e.action === 'contract-superseded')).toHaveLength(1);
  });

  it('the deal sheet explains the contract it renegotiates, with numbers from the data (FR-14)', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    const parent = h.store.contracts.find((c) => c.requestId === REQUEST_ID);
    if (!parent) throw new Error('parent contract missing');
    parent.projectedDate = '2026-12-13';
    h.deps.monitor.workAhead = async () => ({
      issues: 20, countedKeys: [], countedSprintIds: [], pinnedKeys: [], pessimistic: 9, committedIssues: 14, contractIssues: 6, criticalBugs: 2,
    });
    await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    await runRound1(h.deps, RENEGOTIATION_ID);
    await runRound2(h.deps, RENEGOTIATION_ID);
    const sheet = await buildDealSheet({
      store: h.store,
      request: (await h.store.getRequest(RENEGOTIATION_ID))!,
      requester: MOB,
      provider: PAY,
      viewerSides: [],
      visibleKeys: async () => null,
      sameApproverAllowed: false,
      canRetry: false,
    });
    expect(sheet.renegotiationContext).toEqual({
      text: `Renegotiation of the contract for PAY-100: agreed ${formatDate(parent.agreedDateMax)}, now projected Dec 13, 2026 after 2 critical bugs.`,
      issueKeys: ['PAY-100'],
    });
    expect(renegotiationContext({ ...parent, projectedDate: null }, null)).toBe(
      `Renegotiation of the contract for PAY-100: agreed ${formatDate(parent.agreedDateMax)}, now projected beyond the planning horizon.`,
    );
  });

  it('releases the claim when the provider limit blocks it, so the next run opens the same episode', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    for (let i = 0; i < 20; i += 1) {
      await h.store.insertRequest(request({ id: `req-user-${i}`, sourceIssueKey: `MOB-${200 + i}`, status: 'rejected' }), { maxPerProviderPerHour: Infinity });
    }
    const blocked = await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    expect(blocked.status).toBe('skipped');
    expect(h.store.renegotiations).toEqual([]);
    expect(h.store.auditLog.find((e) => e.action === 'renegotiation-failed')?.payload).toMatchObject({ retried: true });
    h.store.now += 3601;
    const retried = await openRenegotiation(h.deps, input, 'req-00000000-0000-4000-8000-0000000000ee');
    expect(retried).toMatchObject({ status: 'opened', requestId: 'req-00000000-0000-4000-8000-0000000000ee' });
  });

  it('releases the claim after a transient error and opens on the next run', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    h.store.failNextInsert = new Error('SQL connection reset');
    await expect(openRenegotiation(h.deps, input, RENEGOTIATION_ID)).rejects.toThrow('SQL connection reset');
    expect(h.store.renegotiations).toEqual([]);
    expect((await openRenegotiation(h.deps, input, RENEGOTIATION_ID)).status).toBe('opened');
  });

  it('requests opened by the app do not count towards the provider limit', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    for (let i = 0; i < 20; i += 1) {
      await h.store.insertRequest(request({ id: `req-app-${i}`, sourceIssueKey: `MOB-${300 + i}`, createdBy: APP_CREATOR, status: 'rejected' }));
    }
    expect((await openRenegotiation(h.deps, input, RENEGOTIATION_ID)).status).toBe('opened');
  });

  it('parallel runs on one claim, or an open request on the issue, return exists without a failure audit', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    const results = await Promise.all([
      openRenegotiation(h.deps, input, RENEGOTIATION_ID),
      openRenegotiation(h.deps, input, 'req-00000000-0000-4000-8000-0000000000bb'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['exists', 'opened']);
    expect(results.every((r) => r.requestId === RENEGOTIATION_ID)).toBe(true);

    const other = harness({ commitments: shiftScenario() });
    const otherInput = await trigger(other);
    await other.store.insertRequest(request({ id: 'req-user-open', status: 'negotiating' }));
    expect(await openRenegotiation(other.deps, otherInput, RENEGOTIATION_ID)).toMatchObject({ status: 'exists', requestId: null });
    expect(other.store.renegotiations).toEqual([]);
    for (const log of [h.store.auditLog, other.store.auditLog]) {
      expect(log.filter((e) => e.action === 'renegotiation-failed')).toEqual([]);
    }
  });

  it('demo reset cancels undecided renegotiations (audited, kept) and leaves decided ones', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    await runRound1(h.deps, RENEGOTIATION_ID);
    await runRound2(h.deps, RENEGOTIATION_ID);
    const cancelled = await cancelUndecidedRenegotiations(h.deps, PAY.id, 'lead-payments', 'Demo bugs reset');
    expect(cancelled).toEqual([RENEGOTIATION_ID]);
    expect((await h.store.getRequest(RENEGOTIATION_ID))?.status).toBe('cancelled');
    expect(h.store.auditLog.find((e) => e.entityId === RENEGOTIATION_ID && e.action === 'cancelled')).toMatchObject({
      actor: 'lead-payments',
      payload: { reason: 'Demo bugs reset' },
    });
    expect(await cancelUndecidedRenegotiations(h.deps, PAY.id, null, 'again')).toEqual([]);
    // The cancelled one no longer blocks a renegotiation in a later at-risk episode.
    const next = await openRenegotiation(h.deps, { ...input, episode: 2 }, 'req-00000000-0000-4000-8000-0000000000dd');
    expect(next.status).toBe('opened');
  });
});

describe('escalate (FR-15)', () => {
  async function rejected(h: Harness) {
    await h.store.insertRequest(request({ size: 'L' }));
    await runRound1(h.deps, REQUEST_ID);
    await runRound2(h.deps, REQUEST_ID);
    const broker = await h.store.getRound(REQUEST_ID, 2, 'broker');
    const [best] = (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
    const before = h.jira.comments.length;
    await decide(h.deps, {
      requestId: REQUEST_ID,
      optionId: best,
      side: 'provider',
      decision: 'reject',
      reason: 'Ledger cleanup cannot move',
      accountId: 'lead-payments',
    });
    return h.jira.comments.slice(before);
  }

  it('a rejection mentions the charter contact and the project-lead fallback in one neutral comment', async () => {
    const h = harness({ commitments: shiftScenario() });
    const posted = await rejected(h);
    expect(posted).toHaveLength(1);
    expect(posted[0].issueKey).toBe('MOB-7');
    expect(posted[0].mentions).toEqual(['lead-mobile', 'escalate-payments']);
    expect(posted[0].text).toContain('Accord escalation: Mobile and Payments reached no agreement');
    expect(posted[0].text).toContain('The Payments lead rejected the deal sheet. Reason given: "Ledger cleanup cannot move".');
    const escalated = h.store.auditLog.filter((e) => e.action === 'escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].payload).toMatchObject({
      trigger: 'rejected',
      as: 'app',
      contacts: [
        { accountId: 'lead-mobile', source: 'project-lead', name: 'Mia Mobile' },
        { accountId: 'escalate-payments', source: 'charter', name: 'Erin Escalation' },
      ],
    });
  });

  it('is idempotent per request', async () => {
    const h = harness({ commitments: shiftScenario() });
    await rejected(h);
    const again = await escalate(h.deps, REQUEST_ID, 'rejected');
    expect(again.status).toBe('skipped');
    expect(h.jira.comments.filter((c) => c.text.startsWith('Accord escalation'))).toHaveLength(1);
    expect(h.store.auditLog.filter((e) => e.action === 'escalated')).toHaveLength(1);
  });

  it('a failed comment leaves no escalated marker; the retry posts it once', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.jira.failComment = true;
    expect(await rejected(h)).toEqual([]);
    expect(h.store.auditLog.filter((e) => e.action === 'escalated')).toEqual([]);
    expect(h.store.auditLog.find((e) => e.action === 'escalation-failed')?.payload).toMatchObject({ trigger: 'rejected', error: 'comment failed' });
    h.jira.failComment = false;
    const retried = await retryEscalations(h.deps, [REQUEST_ID]);
    expect(retried).toEqual([expect.objectContaining({ requestId: REQUEST_ID, status: 'done' })]);
    expect(await retryEscalations(h.deps, [REQUEST_ID])).toEqual([expect.objectContaining({ status: 'skipped', detail: 'already escalated' })]);
    expect(h.jira.comments.filter((c) => c.text.startsWith('Accord escalation'))).toHaveLength(1);
    expect(h.store.auditLog.filter((e) => e.action === 'escalated')).toHaveLength(1);
  });

  it('does not name a team when no rejection is stored', async () => {
    const h = harness({ commitments: shiftScenario() });
    await h.store.insertRequest(request({ status: 'rejected' }));
    await escalate(h.deps, REQUEST_ID, 'rejected');
    const text = h.jira.comments.at(-1)?.text ?? '';
    expect(text).toContain('The deal sheet was rejected.');
    expect(text).not.toMatch(/The (Payments|Mobile) lead rejected/);
  });

  it('falls back to the project lead when a team has no charter contact', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.escalationContacts.set(PAY.id, { accountId: 'lead-payments-project', source: 'project-lead' });
    const posted = await rejected(h);
    expect(posted[0].mentions).toEqual(['lead-mobile', 'lead-payments-project']);
    expect(h.store.auditLog.find((e) => e.action === 'escalated')?.payload).toMatchObject({
      contacts: [{ source: 'project-lead' }, { source: 'project-lead', name: 'Paul Payments' }],
    });
  });

  it('audits a fallback note when the charter contact was replaced by the project lead', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.escalationContacts.set(PAY.id, { accountId: 'lead-payments-project', source: 'project-lead', note: 'charter contact cannot browse MOB' });
    const posted = await rejected(h);
    expect(posted[0].mentions).toEqual(['lead-mobile', 'lead-payments-project']);
    expect(h.store.auditLog.find((e) => e.action === 'escalation-contact-fallback')?.payload).toEqual({
      teamKey: PAY.teamKey,
      fallback: 'project-lead',
      note: 'charter contact cannot browse MOB',
    });
    expect(h.store.auditLog.find((e) => e.action === 'escalated')?.payload).toMatchObject({
      contacts: [{ source: 'project-lead' }, { source: 'project-lead', note: 'charter contact cannot browse MOB' }],
    });
  });

  it('audits instead of commenting when nobody can be reached', async () => {
    const h = harness({ commitments: shiftScenario() });
    h.escalationContacts.clear();
    const posted = await rejected(h);
    expect(posted).toEqual([]);
    expect(h.store.auditLog.find((e) => e.action === 'escalation-skipped')).toBeTruthy();
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('rejected');
  });

  it('a failed negotiation is escalated once by the queue consumer', async () => {
    const h = harness({ commitments: shiftScenario() });
    await h.store.insertRequest(request({ size: 'L' }));
    h.deps.teams.planningContext = async () => {
      throw new Error('Jira down');
    };
    const result = await handleNegotiationEvent(h.deps, { type: 'round1', requestId: REQUEST_ID }, 99);
    expect(result.status).toBe('skipped');
    expect((await h.store.getRequest(REQUEST_ID))?.status).toBe('failed');
    const escalation = h.jira.comments.filter((c) => c.text.startsWith('Accord escalation'));
    expect(escalation).toHaveLength(1);
    expect(escalation[0].text).toContain('a background step failed');
    await escalate(h.deps, REQUEST_ID, 'failed');
    expect(h.jira.comments.filter((c) => c.text.startsWith('Accord escalation'))).toHaveLength(1);
  });

  it('a rejected renegotiation is escalated and says the current contract stays in effect', async () => {
    const h = harness({ commitments: shiftScenario() });
    const input = await trigger(h);
    await openRenegotiation(h.deps, input, RENEGOTIATION_ID);
    await runRound1(h.deps, RENEGOTIATION_ID);
    await runRound2(h.deps, RENEGOTIATION_ID);
    const broker = await h.store.getRound(RENEGOTIATION_ID, 2, 'broker');
    const [best] = (broker?.output as { rankedOptionIds: number[] }).rankedOptionIds;
    await decide(h.deps, { requestId: RENEGOTIATION_ID, optionId: best, side: 'requester', decision: 'reject', reason: 'Too late', accountId: 'lead-mobile' });
    const escalation = h.jira.comments.filter((c) => c.text.startsWith('Accord escalation'));
    expect(escalation).toHaveLength(1);
    expect(escalation[0].text).toContain('This was a renegotiation of the contract agreed');
    expect(escalation[0].text).toContain('that contract stays in effect');
    expect((await h.store.getContract(REQUEST_ID))?.status).toBe('at-risk');
  });
});
