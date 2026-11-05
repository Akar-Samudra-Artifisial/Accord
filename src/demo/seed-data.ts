import type { Rule } from '../planner';
import { DEMO_PAYMENTS_CHARTER, DEMO_SIMULATED_THROUGHPUT } from './scenario';

/** Marker label on every issue created by the demo generator. */
export const DEMO_LABEL = 'accord-demo';
/** Jira project property that marks a project as created by Accord (NFR-2 guard). */
export const DEMO_PROJECT_PROPERTY = 'accord.demo';

export interface DemoIssue {
  summary: string;
  issueType: 'Story' | 'Task' | 'Bug';
  priority: 'Highest' | 'High' | 'Medium' | 'Low';
  labels: string[];
  /** Days after the active sprint's end; omitted = no due date. */
  dueInDaysAfterSprintEnd?: number;
}

export interface DemoTeam {
  /**
   * Logical team slot: seed step id suffix and preferred Jira project key. The key actually used
   * is resolved at seed time (see projectKeyCandidates) because the slot key may be taken.
   */
  slot: 'MOB' | 'PAY';
  name: string;
  sprintNumbers: { active: number; next: number };
  activeIssues: DemoIssue[];
  nextIssues: DemoIssue[];
  charter: {
    priorities: string[];
    redLines: Rule[];
    shiftable: Rule[];
    maxExternalShare: number;
    responseDays: number;
  };
  /** Completed issues per closed sprint, oldest first (stored as Simulated history). */
  simulatedThroughput: readonly number[];
}

const issue = (
  summary: string,
  issueType: DemoIssue['issueType'],
  priority: DemoIssue['priority'],
  labels: string[] = [],
  dueInDaysAfterSprintEnd?: number,
): DemoIssue => ({ summary, issueType, priority, labels, dueInDaysAfterSprintEnd });

export const DEMO_TEAMS: readonly DemoTeam[] = [
  {
    slot: 'MOB',
    name: 'Mobile',
    sprintNumbers: { active: 27, next: 28 },
    activeIssues: [
      issue('Holiday theme for the home screen', 'Story', 'High', ['holiday-release'], 0),
      issue('In-app refund request screen', 'Story', 'High', ['refunds']),
      issue('Crash when camera permission is denied on Android 15', 'Bug', 'Highest'),
      issue('Update analytics SDK', 'Task', 'Low', ['tech-debt']),
    ],
    nextIssues: [
      issue('Refund status push notifications', 'Story', 'Medium', ['refunds']),
      issue('Accessibility pass on checkout', 'Story', 'Medium'),
      issue('Move biometric login tokens to secure storage', 'Task', 'High', ['security']),
    ],
    charter: {
      priorities: ['Holiday release', 'Self-service refunds'],
      redLines: [{ field: 'label', value: 'security' }],
      shiftable: [
        { field: 'priority', value: 'Low' },
        { field: 'label', value: 'tech-debt' },
      ],
      maxExternalShare: 0.2,
      responseDays: 2,
    },
    simulatedThroughput: [6, 7, 7, 5, 8, 6],
  },
  {
    slot: 'PAY',
    name: 'Payments',
    sprintNumbers: { active: 41, next: 42 },
    activeIssues: [
      issue('Holiday promo checkout', 'Story', 'High', ['holiday-release'], 0),
      issue('Holiday promo pricing rules', 'Story', 'High', ['holiday-release'], 0),
      issue('Card vault key rotation', 'Task', 'High', ['security']),
      issue('Ledger cleanup', 'Task', 'Low', ['tech-debt']),
      issue('Remove legacy payout cron job', 'Task', 'Medium', ['tech-debt']),
      issue('Rounding error in refund preview', 'Bug', 'Medium'),
      // Shiftable (Medium, no label): with the two demo critical bugs it fills Sprint 41, so a
      // short-notice request needs the on-time-with-shift option (sprint-shift scenario, M4).
      issue('Chargeback webhook retries', 'Story', 'Medium'),
    ],
    nextIssues: [
      issue('Ledger migration phase 2: schema', 'Story', 'High', ['ledger-migration']),
      issue('Ledger migration phase 2: backfill', 'Story', 'High', ['ledger-migration']),
      issue('Settlement report export', 'Story', 'Medium'),
      issue('PCI log retention update', 'Task', 'High', ['security']),
      issue('Upgrade payment provider SDK', 'Task', 'Low', ['tech-debt']),
    ],
    charter: {
      priorities: DEMO_PAYMENTS_CHARTER.priorities,
      redLines: DEMO_PAYMENTS_CHARTER.redLines,
      shiftable: DEMO_PAYMENTS_CHARTER.shiftable,
      maxExternalShare: DEMO_PAYMENTS_CHARTER.maxExternalShare,
      responseDays: DEMO_PAYMENTS_CHARTER.responseDays,
    },
    simulatedThroughput: DEMO_SIMULATED_THROUGHPUT,
  },
];

export const SPRINT_LENGTH_DAYS = 14;

export function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Active sprint started 3 days ago; next sprint follows directly. */
export function demoSprintDates(today: string) {
  const activeStart = addDaysIso(today, -3);
  const activeEnd = addDaysIso(activeStart, SPRINT_LENGTH_DAYS - 1);
  const nextStart = addDaysIso(activeEnd, 1);
  const nextEnd = addDaysIso(nextStart, SPRINT_LENGTH_DAYS - 1);
  return { activeStart, activeEnd, nextStart, nextEnd };
}

/** Simulated closed sprints right before the active sprint (oldest first). */
export function simulatedHistory(team: DemoTeam, today: string, projectKey: string = team.slot) {
  const { activeStart } = demoSprintDates(today);
  const count = team.simulatedThroughput.length;
  return team.simulatedThroughput.map((completedCount, index) => {
    const sprintNumber = team.sprintNumbers.active - (count - index);
    const endDate = addDaysIso(activeStart, -1 - SPRINT_LENGTH_DAYS * (count - 1 - index));
    return {
      sprintId: `sim-${projectKey}-${sprintNumber}`,
      sprintName: `${team.name} Sprint ${sprintNumber}`,
      completedCount,
      endDate,
      source: 'simulated' as const,
    };
  });
}

export const SEED_STEPS = [
  'project:MOB',
  'project:PAY',
  'sprints:MOB',
  'sprints:PAY',
  'charter:MOB',
  'charter:PAY',
  'history',
] as const;

export type SeedStep = (typeof SEED_STEPS)[number];

export function demoTeam(slot: string): DemoTeam {
  const team = DEMO_TEAMS.find((candidate) => candidate.slot === slot);
  if (!team) throw new Error(`Unknown demo team ${slot}`);
  return team;
}

export const MAX_KEY_SUFFIX = 9;

/** `base`, then `alt`, `alt2` … `alt9` (without duplicates when base equals alt). */
export function keyCandidates(base: string, alt: string): string[] {
  return [...new Set([base, alt, ...Array.from({ length: MAX_KEY_SUFFIX - 1 }, (_, i) => `${alt}${i + 2}`)])];
}

/** Preferred key first, then AC<slot>, AC<slot>2 … (uppercase, 2–10 characters). */
export function projectKeyCandidates(slot: string): string[] {
  return keyCandidates(slot, `AC${slot}`);
}

export type KeyState = 'missing' | 'accord' | 'foreign';

/**
 * First candidate that is free or already owned by Accord. Stateless and deterministic, so every
 * seed step resolves the same key again (a key created by Accord turns from missing into accord).
 */
export async function pickKey(
  candidates: readonly string[],
  probe: (key: string) => Promise<KeyState>,
): Promise<{ key: string; state: Exclude<KeyState, 'foreign'> }> {
  for (const key of candidates) {
    const state = await probe(key);
    if (state !== 'foreign') return { key, state };
  }
  throw new Error(`All candidate keys are taken by other apps or users: ${candidates.join(', ')}`);
}
