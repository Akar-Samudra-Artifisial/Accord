import type { Charter, Rule } from '../planner';

/**
 * Accord charter page format (Confluence storage format, pure functions only).
 * Every field is an `<h2>` heading followed by a list or paragraphs.
 */

export const CHARTER_LABEL = 'accord-charter';

export type CharterFieldKey =
  | 'priorities'
  | 'redLines'
  | 'shiftable'
  | 'maxExternalShare'
  | 'responseDays'
  | 'approvers'
  | 'escalationContact';

export interface CharterField {
  key: CharterFieldKey;
  heading: string;
  required: boolean;
}

export const CHARTER_FIELDS: readonly CharterField[] = [
  { key: 'priorities', heading: 'Quarter priorities', required: true },
  { key: 'redLines', heading: 'Red lines', required: true },
  { key: 'shiftable', heading: 'Shiftable work', required: true },
  { key: 'maxExternalShare', heading: 'Max share for other teams', required: true },
  { key: 'responseDays', heading: 'Response time', required: true },
  { key: 'approvers', heading: 'Approvers', required: true },
  { key: 'escalationContact', heading: 'Escalation contact', required: false },
];

export interface CharterTemplateInput {
  teamName: string;
  priorities: string[];
  redLines: Rule[];
  shiftable: Rule[];
  maxExternalShare: number;
  responseDays: number;
  approverAccountIds: string[];
  escalationAccountId?: string;
}

const RULE_PREFIX: Record<Rule['field'], string> = {
  label: 'Label',
  issueType: 'Issue type',
  priority: 'Priority',
};

export function charterPageTitle(teamName: string): string {
  return `${teamName} team charter`;
}

export interface CharterBylineState {
  isCharter: boolean;
  teamName: string | null;
  valid: boolean;
  missing: string[];
}

/**
 * Byline status computed only from the Confluence page itself. Forge SQL is
 * provisioned per installation, so the Confluence installation cannot see the
 * team rows stored by the Jira installation.
 */
export function charterBylineState(title: string, storage: string): CharterBylineState {
  const validation = validateCharterStorage(storage);
  const isCharter = Object.keys(parseCharterSections(storage)).length > 0;
  const match = /^(.+) team charter$/.exec(title.trim());
  return {
    isCharter,
    teamName: isCharter && match ? match[1] : null,
    valid: validation.valid,
    missing: validation.missing,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mention(accountId: string): string {
  return `<ac:link><ri:user ri:account-id="${escapeXml(accountId)}" /></ac:link>`;
}

function list(tag: 'ul' | 'ol', items: readonly string[]): string {
  return `<${tag}>${items.map((item) => `<li><p>${item}</p></li>`).join('')}</${tag}>`;
}

export function formatRule(rule: Rule): string {
  return `${RULE_PREFIX[rule.field]}: ${rule.value}`;
}

const APPROVERS_SECTION = /(<h2[^>]*>\s*Approvers\s*<\/h2>)([\s\S]*?)(?=<h2[\s>]|$)/i;

/**
 * Replaces only the Approvers section of a charter page; the other sections stay as written.
 * Returns null when the page has no Approvers heading.
 */
export function replaceApprovers(storage: string, accountIds: readonly string[]): string | null {
  if (!APPROVERS_SECTION.test(storage) || accountIds.length === 0) return null;
  return storage.replace(APPROVERS_SECTION, (_match, heading: string) => `${heading}${list('ul', accountIds.map(mention))}`);
}

/** Storage-format body of a new charter page. */
export function buildCharterStorage(input: CharterTemplateInput): string {
  const sections: Record<CharterFieldKey, string> = {
    priorities: list('ol', input.priorities.map(escapeXml)),
    redLines: list('ul', input.redLines.map((rule) => escapeXml(formatRule(rule)))),
    shiftable: list('ul', input.shiftable.map((rule) => escapeXml(formatRule(rule)))),
    maxExternalShare: `<p>${Math.round(input.maxExternalShare * 100)}%</p>`,
    responseDays: `<p>${input.responseDays} working days</p>`,
    approvers: input.approverAccountIds.length
      ? list('ul', input.approverAccountIds.map(mention))
      : '<p>Mention at least one approver here with @.</p>',
    escalationContact: input.escalationAccountId ? `<p>${mention(input.escalationAccountId)}</p>` : '<p></p>',
  };
  const intro =
    `<p>This is the Accord charter of the ${escapeXml(input.teamName)} team. ` +
    'Accord reads every section below to answer dependency requests. Keep the headings unchanged; ' +
    'write rules as <code>Label: name</code>, <code>Issue type: name</code> or <code>Priority: name</code>.</p>';
  return intro + CHARTER_FIELDS.map((field) => `<h2>${field.heading}</h2>${sections[field.key]}`).join('');
}

export interface CharterItem {
  text: string;
  accountIds: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function toText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function accountIdsIn(fragment: string): string[] {
  return [...fragment.matchAll(/ri:account-id="([^"]+)"/g)].map((match) => decodeEntities(match[1]));
}

function itemsOf(section: string): CharterItem[] {
  const listItems = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => match[1]);
  const blocks = listItems.length
    ? listItems
    : [...section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => match[1]);
  const fragments = blocks.length ? blocks : [section];
  return fragments
    .map((fragment) => ({ text: toText(fragment), accountIds: accountIdsIn(fragment) }))
    .filter((item) => item.text.length > 0 || item.accountIds.length > 0);
}

function normalizeHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/** Splits a storage body into charter sections keyed by field (unknown headings are ignored). */
export function parseCharterSections(storage: string): Partial<Record<CharterFieldKey, CharterItem[]>> {
  const byHeading = new Map(CHARTER_FIELDS.map((field) => [normalizeHeading(field.heading), field.key]));
  const sections: Partial<Record<CharterFieldKey, CharterItem[]>> = {};
  const parts = storage.split(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  // parts = [before, heading1, body1, heading2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const key = byHeading.get(normalizeHeading(toText(parts[i])));
    if (key && !sections[key]) sections[key] = itemsOf(parts[i + 1] ?? '');
  }
  return sections;
}

const RULE_FIELDS: Record<string, Rule['field']> = {
  label: 'label',
  labels: 'label',
  'issue type': 'issueType',
  'issue types': 'issueType',
  type: 'issueType',
  priority: 'priority',
  priorities: 'priority',
};

/** "Priority: Low, Medium" → two rules. Returns null when the line is not a rule. */
export function parseRuleLine(line: string): Rule[] | null {
  const match = /^([a-z ]+?)\s*[:=]\s*(.+)$/i.exec(line.trim());
  if (!match) return null;
  const field = RULE_FIELDS[match[1].toLowerCase().trim()];
  if (!field) return null;
  const values = match[2]
    .split(',')
    .map((value) => value.replace(/[`'"]/g, '').trim())
    .filter(Boolean);
  return values.length ? values.map((value) => ({ field, value })) : null;
}

export interface CharterProblem {
  field: CharterFieldKey;
  heading: string;
  message: string;
}

export interface CharterValidation {
  valid: boolean;
  /** Headings of required fields that are missing or unreadable. */
  missing: string[];
  problems: CharterProblem[];
  /** Present only when valid. */
  charter: Charter | null;
}

function headingOf(key: CharterFieldKey): string {
  return CHARTER_FIELDS.find((field) => field.key === key)?.heading ?? key;
}

/** Parses and validates a charter page body. */
export function validateCharterStorage(storage: string): CharterValidation {
  const sections = parseCharterSections(storage);
  const problems: CharterProblem[] = [];
  const problem = (field: CharterFieldKey, message: string) =>
    problems.push({ field, heading: headingOf(field), message });

  const priorities = (sections.priorities ?? []).map((item) => item.text).filter(Boolean);
  if (priorities.length === 0) problem('priorities', 'List at least one quarter priority.');

  const readRules = (field: 'redLines' | 'shiftable'): Rule[] => {
    const rules: Rule[] = [];
    for (const item of sections[field] ?? []) {
      const parsed = parseRuleLine(item.text);
      if (parsed) rules.push(...parsed);
      else problem(field, `Could not read "${item.text}". Use Label: name, Issue type: name or Priority: name.`);
    }
    if (rules.length === 0 && !problems.some((p) => p.field === field)) {
      problem(field, 'Add at least one rule.');
    }
    return rules;
  };
  const redLines = readRules('redLines');
  const shiftable = readRules('shiftable');

  let maxExternalShare = NaN;
  const shareText = sections.maxExternalShare?.[0]?.text ?? '';
  const shareMatch = /(\d+(?:\.\d+)?)\s*(%?)/.exec(shareText);
  if (shareMatch) {
    const value = Number(shareMatch[1]);
    maxExternalShare = shareMatch[2] === '%' || value > 1 ? value / 100 : value;
  }
  if (!(maxExternalShare > 0 && maxExternalShare <= 1)) {
    problem('maxExternalShare', 'Write a percentage between 1% and 100%, for example 25%.');
  }

  const daysMatch = /(\d+)/.exec(sections.responseDays?.[0]?.text ?? '');
  const responseDays = daysMatch ? Number(daysMatch[1]) : NaN;
  if (!(Number.isInteger(responseDays) && responseDays >= 1 && responseDays <= 30)) {
    problem('responseDays', 'Write the response time in working days, for example "2 working days".');
  }

  const approvers = [...new Set((sections.approvers ?? []).flatMap((item) => item.accountIds))];
  if (approvers.length === 0) problem('approvers', 'Mention at least one approver with @.');

  const escalationContact = sections.escalationContact?.flatMap((item) => item.accountIds)[0];

  const missing = [...new Set(problems.map((p) => p.heading))];
  const valid = problems.length === 0;
  return {
    valid,
    missing,
    problems,
    charter: valid
      ? { priorities, redLines, shiftable, maxExternalShare, responseDays, approvers, escalationContact }
      : null,
  };
}
