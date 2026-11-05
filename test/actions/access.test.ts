import { describe, expect, it } from 'vitest';
import { requireTeamAccess, TEAM_ACCESS_DENIED, type TeamAccessChecks } from '../../src/actions/access';
import { PAY } from '../negotiation/fakes';

function checks(browse: boolean | Error): TeamAccessChecks & { browseCalls: string[] } {
  const browseCalls: string[] = [];
  return {
    browseCalls,
    approvers: async () => ['lead-payments'],
    async canBrowseProject(projectKey, viewer) {
      browseCalls.push(`${projectKey}:${viewer.as}`);
      if (browse instanceof Error) throw browse;
      return browse;
    },
  };
}

describe('requireTeamAccess', () => {
  it('lets approvers and project leads in without a Jira permission call', async () => {
    const c = checks(false);
    await expect(requireTeamAccess(PAY, { accountId: 'lead-payments', as: 'user' }, c)).resolves.toBeUndefined();
    expect(c.browseCalls).toEqual([]);
  });

  it('lets users in who can browse the team project (checked as the user)', async () => {
    const c = checks(true);
    await expect(requireTeamAccess(PAY, { accountId: 'someone', as: 'user' }, c)).resolves.toBeUndefined();
    expect(c.browseCalls).toEqual(['PAY:user']);
  });

  it('rejects everyone else with a generic error', async () => {
    await expect(requireTeamAccess(PAY, { accountId: 'outsider', as: 'user' }, checks(false))).rejects.toThrow(TEAM_ACCESS_DENIED);
  });

  it('fails closed when the permission check errors', async () => {
    await expect(requireTeamAccess(PAY, { accountId: 'outsider', as: 'user' }, checks(new Error('HTTP 500')))).rejects.toThrow(TEAM_ACCESS_DENIED);
  });

  it('requires a signed-in user', async () => {
    await expect(requireTeamAccess(PAY, { accountId: undefined, as: 'app' }, checks(true))).rejects.toThrow(/signed-in Jira user/);
  });
});
