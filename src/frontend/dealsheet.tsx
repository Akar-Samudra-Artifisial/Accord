import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  Link,
  List,
  ListItem,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  TextArea,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { formatDate, formatDateRange } from '../format/dates';
import { requestIsMoving, useBoundedPolling } from './polling';

/** Shared deal sheet: inline in the issue panel, modal in the global page Inbox. */

type Failure = { ok: false; error: string };
export type Side = 'requester' | 'provider';

export async function call<T>(key: string, payload?: Record<string, unknown>): Promise<({ ok: true } & T) | Failure> {
  try {
    const response = await invoke<({ ok: true } & T) | Failure>(key, payload);
    return 'body' in response ? response.body : response;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `Request ${key} failed` };
  }
}

export type RequestStatus = 'negotiating' | 'awaiting-approval' | 'approved' | 'contracted' | 'rejected' | 'failed' | 'cancelled';

export const STATUS_LABEL: Record<RequestStatus, { text: string; appearance: 'inprogress' | 'new' | 'moved' | 'success' | 'removed' }> = {
  negotiating: { text: 'Negotiating', appearance: 'inprogress' },
  'awaiting-approval': { text: 'Awaiting approval', appearance: 'new' },
  approved: { text: 'Approved, updating Jira', appearance: 'moved' },
  contracted: { text: 'Contracted', appearance: 'success' },
  rejected: { text: 'Rejected', appearance: 'removed' },
  failed: { text: 'Failed', appearance: 'removed' },
  cancelled: { text: 'Cancelled', appearance: 'moved' },
};

/** FR-14 / FR-15 badges shared by the issue panel and the Inbox. */
export const RenegotiationLozenge = () => <Lozenge appearance="new">Renegotiation</Lozenge>;
export const EscalatedLozenge = () => <Lozenge appearance="removed" isBold>Escalated</Lozenge>;

export const StatusLozenge = ({ status }: { status: RequestStatus }) => (
  <Lozenge appearance={STATUS_LABEL[status].appearance}>{STATUS_LABEL[status].text}</Lozenge>
);

interface OptionView {
  id: number;
  kind: string;
  label: string;
  dateRange: { min: string; max: string };
  meetsNeed: boolean;
  recommended: boolean;
  fromVariation: boolean;
  shifted: Array<{ key: string; toSprint: string; toBacklog: boolean }>;
  rulesUsed: string[];
  consequences: { requester: string; provider: string };
  explanation: string;
  trace: Array<{ step: string; text: string }>;
  jiraChanges: Array<{ kind: string; text: string }>;
}

interface SideStatus {
  decision: 'approve' | 'reject' | null;
  optionId: number | null;
  optionLabel: string | null;
  byViewer: boolean;
}

interface DealSheet {
  request: { id: string; title: string; status: RequestStatus; sourceIssueKey: string | null; neededBy: string; size: string; minSize: number | null };
  requester: { teamKey: string; name: string };
  provider: { teamKey: string; name: string; projectKey: string };
  options: OptionView[];
  transcript: Array<{ round: number; speaker: string; text: string }>;
  rounds: Array<{ roundNo: number; role: string; status: string; error: string | null }>;
  approvals: Array<{ side: Side; decision: 'approve' | 'reject'; optionId: number; reason: string | null }>;
  agreedOptionId: number | null;
  canDecideAs: Side[];
  sameApproverAllowed: boolean;
  canRetry: boolean;
  contract: { optionId: number; deliverableIssueKey: string | null; agreedDateMin: string; agreedDateMax: string; status: string } | null;
  sideStatus: Record<Side, SideStatus>;
  appliedChanges: Array<{ kind: string; text: string; issueKeys: string[] }>;
  /** Set for a renegotiation (FR-14): the replaced contract's agreed and projected dates. */
  renegotiationContext: { text: string; issueKeys: string[] } | null;
}

interface DecisionResult {
  status: string;
  detail: string;
}

const cardStyle = xcss({
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'radius.medium',
  padding: 'space.200',
  width: '100%',
});

const featuredCardStyle = xcss({
  borderColor: 'color.border.success',
  borderStyle: 'solid',
  borderWidth: 'border.width.selected',
  borderRadius: 'radius.medium',
  padding: 'space.200',
  width: '100%',
});

const ISSUE_KEY_IN_TEXT = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

const dateRange = (range: { min: string; max: string }) => formatDateRange(range.min, range.max, 'No date offered');

const teamName = (sheet: DealSheet, side: Side) => (side === 'requester' ? sheet.requester.name : sheet.provider.name);

/** Renders text with the given issue keys as links to the issue (same Jira site). */
const LinkedText = ({ text, keys }: { text: string; keys: readonly string[] }) => {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ISSUE_KEY_IN_TEXT)) {
    const index = match.index ?? 0;
    if (!keys.includes(match[0])) continue;
    parts.push(text.slice(last, index));
    parts.push(
      <Link key={`${match[0]}-${index}`} href={`/browse/${match[0]}`} openNewTab>
        {match[0]}
      </Link>,
    );
    last = index + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <Text>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </Text>
  );
};

/** "Mobile: approved by you (On time) · Payments: pending" as lozenges. */
const SideStatusRow = ({ sheet }: { sheet: DealSheet }) => {
  const sides: Side[] = ['requester', 'provider'];
  return (
    <Inline space="space.200" alignBlock="center" shouldWrap>
      {sides.map((side) => {
        const status = sheet.sideStatus[side];
        const who = status.byViewer ? ' by you' : '';
        const text =
          status.decision === 'approve'
            ? `approved${who}${status.optionLabel ? ` · ${status.optionLabel}` : ''}`
            : status.decision === 'reject'
              ? `rejected${who}`
              : 'decision pending';
        const appearance = status.decision === 'approve' ? 'success' : status.decision === 'reject' ? 'removed' : 'default';
        return (
          <Inline key={side} space="space.075" alignBlock="center">
            <Text weight="medium">{`${teamName(sheet, side)} lead`}</Text>
            <Lozenge appearance={appearance}>{text}</Lozenge>
          </Inline>
        );
      })}
    </Inline>
  );
};

const Toggle = ({ open, onToggle, show, hide }: { open: boolean; onToggle: () => void; show: string; hide: string }) => (
  <Inline>
    <Button appearance="subtle" spacing="compact" onClick={onToggle}>
      {open ? hide : show}
    </Button>
  </Inline>
);

const OptionDetails = ({ option, showPreview }: { option: OptionView; showPreview: boolean }) => (
  <Stack space="space.150">
    <Stack space="space.050">
      <Heading size="xxsmall">Why these numbers</Heading>
      <List type="ordered">
        {option.trace.map((step, index) => (
          <ListItem key={`${option.id}-trace-${index}`}>
            <Text>{step.text}</Text>
          </ListItem>
        ))}
      </List>
    </Stack>
    <Stack space="space.050">
      <Heading size="xxsmall">Charter rules used</Heading>
      <Text>{option.rulesUsed.length ? option.rulesUsed.join('; ') : 'None'}</Text>
    </Stack>
    {showPreview && option.jiraChanges.length ? (
      <Stack space="space.050">
        <Heading size="xxsmall">If approved, Accord changes in Jira</Heading>
        <List type="unordered">
          {option.jiraChanges.map((change, index) => (
            <ListItem key={`${option.id}-change-${index}`}>
              <Text>{change.text}</Text>
            </ListItem>
          ))}
        </List>
      </Stack>
    ) : null}
  </Stack>
);

const OptionCard = ({
  option,
  sheet,
  busy,
  featured,
  onDecide,
}: {
  option: OptionView;
  sheet: DealSheet;
  busy: boolean;
  featured: boolean;
  onDecide: (option: OptionView, side: Side) => void;
}) => {
  const [open, setOpen] = useState(false);
  const approvedBy = (['requester', 'provider'] as Side[]).filter(
    (side) => sheet.sideStatus[side].decision === 'approve' && sheet.sideStatus[side].optionId === option.id,
  );
  const isAgreed = sheet.contract?.optionId === option.id;
  const deciding = sheet.request.status === 'awaiting-approval' || sheet.request.status === 'negotiating';
  return (
    <Box xcss={featured ? featuredCardStyle : cardStyle}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Heading size={featured ? 'small' : 'xsmall'}>{option.label}</Heading>
          {isAgreed ? <Lozenge appearance="success" isBold>Agreed</Lozenge> : null}
          {!isAgreed && option.recommended ? <Lozenge appearance="success" isBold>Recommended</Lozenge> : null}
          <Lozenge appearance={option.meetsNeed ? 'success' : 'moved'}>{option.meetsNeed ? 'Meets need date' : 'Misses need date'}</Lozenge>
          {option.fromVariation ? <Lozenge appearance="new">Counter-proposal</Lozenge> : null}
          {approvedBy.map((side) => (
            <Lozenge key={side} appearance="success">{`Approved by ${teamName(sheet, side)}`}</Lozenge>
          ))}
        </Inline>
        <Text weight="bold" size={featured ? 'large' : 'medium'}>
          {dateRange(option.dateRange)}
        </Text>
        <Text>
          <Strong>{`${sheet.requester.name}: `}</Strong>
          {option.consequences.requester}
        </Text>
        <Text>
          <Strong>{`${sheet.provider.name}: `}</Strong>
          {option.consequences.provider}
        </Text>
        {option.kind !== 'reject' && sheet.canDecideAs.length ? (
          <Inline space="space.100" shouldWrap>
            {sheet.canDecideAs.map((side) => (
              <Button
                key={side}
                appearance={featured ? 'primary' : 'default'}
                isDisabled={busy}
                onClick={() => onDecide(option, side)}
              >
                {`Approve as ${teamName(sheet, side)} lead`}
              </Button>
            ))}
          </Inline>
        ) : null}
        <Toggle open={open} onToggle={() => setOpen((value) => !value)} show="Show details" hide="Hide details" />
        {open ? <OptionDetails option={option} showPreview={deciding} /> : null}
      </Stack>
    </Box>
  );
};

const AppliedChanges = ({ sheet }: { sheet: DealSheet }) => {
  const contract = sheet.contract;
  if (!contract) return null;
  return (
    <SectionMessage appearance="success" title="Changes applied">
      <Stack space="space.100">
        <LinkedText
          text={`Contract active: ${contract.deliverableIssueKey ?? 'the deliverable'} is due ${dateRange({ min: contract.agreedDateMin, max: contract.agreedDateMax })}.`}
          keys={contract.deliverableIssueKey ? [contract.deliverableIssueKey] : []}
        />
        {sheet.appliedChanges.length ? (
          <List type="unordered">
            {sheet.appliedChanges.map((change, index) => (
              <ListItem key={`applied-${index}`}>
                <LinkedText text={change.text} keys={change.issueKeys} />
              </ListItem>
            ))}
          </List>
        ) : null}
      </Stack>
    </SectionMessage>
  );
};

/** Human message for a decision, using the option name and dates instead of internal ids. */
function decisionMessage(result: DecisionResult, option: OptionView, decision: 'approve' | 'reject'): string {
  const named = `"${option.label}" (${dateRange(option.dateRange)})`;
  if (decision === 'reject' || result.status === 'rejected') return 'Request rejected. The requester can resize, re-date or escalate it.';
  if (result.status === 'agreed') return `Both leads approved ${named}. Accord is now updating Jira.`;
  if (result.status === 'recorded') return `You approved ${named}, but the other team approved a different option. Both leads must approve the same option.`;
  return `You approved ${named}. Waiting for the other team lead.`;
}

interface DealSheetProps {
  requestId: string;
  onClose: () => void;
  /** Called when the request status changes, so the caller can refresh its badges. */
  onChanged?: () => void;
}

/** Deal sheet in a modal (global page). */
export const DealSheetModal = (props: DealSheetProps) => <DealSheetView {...props} inline={false} />;

/**
 * Deal sheet expanded in place (issue panel). A UI Kit Modal opened from the issue panel right after Jira
 * refreshed the issue (Accord's "deal sheet ready" comment) sometimes did not appear on the first click.
 */
export const DealSheetInline = (props: DealSheetProps) => <DealSheetView {...props} inline />;

const DealSheetView = ({ requestId, onClose, onChanged, inline }: DealSheetProps & { inline: boolean }) => {
  const [sheet, setSheet] = useState<DealSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [showOthers, setShowOthers] = useState(true);
  const [showTranscript, setShowTranscript] = useState(false);
  const lastStatus = useRef<RequestStatus | null>(null);
  // Kept in a ref so a new callback from the parent does not restart polling.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    const result = await call<{ sheet: DealSheet }>('getDealSheet', { requestId });
    if (result.ok) {
      setSheet(result.sheet);
      setError(null);
      const status = result.sheet.request.status;
      if (lastStatus.current !== null && lastStatus.current !== status) {
        // The status banner now tells the story; drop the stale decision message.
        if (status === 'contracted' || status === 'failed') setMessage(null);
        onChangedRef.current?.();
      }
      lastStatus.current = status;
    } else setError(result.error);
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rounds and apply-contract run in the background queue; poll until a final status.
  const pending = sheet ? requestIsMoving(sheet.request.status) || sheet.contract?.status === 'applying' : false;
  const { exhausted, restart: restartPolling } = useBoundedPolling(pending, load);

  const decide = async (option: OptionView, side: Side, decision: 'approve' | 'reject') => {
    setBusy(true);
    setMessage(null);
    setError(null);
    const result = await call<{ result: DecisionResult }>('decide', {
      requestId,
      optionId: option.id,
      side,
      decision,
      ...(decision === 'reject' ? { reason } : {}),
    });
    if (result.ok) {
      setMessage(decisionMessage(result.result, option, decision));
      restartPolling();
      onChangedRef.current?.();
    } else setError(result.error);
    await load();
    setBusy(false);
  };

  const retry = async () => {
    setBusy(true);
    setMessage(null);
    const result = await call<{ result: DecisionResult }>('retryRequest', { requestId });
    if (result.ok) {
      setMessage('Negotiation restarted. The delegates are working on it again.');
      restartPolling();
    } else setError(result.error);
    await load();
    setBusy(false);
  };

  const status = sheet?.request.status;
  const featured =
    sheet?.options.find((option) => option.id === sheet.contract?.optionId) ??
    sheet?.options.find((option) => option.recommended) ??
    sheet?.options[0];
  const others = sheet && featured ? sheet.options.filter((option) => option.id !== featured.id) : [];
  const settled = status === 'approved' || status === 'contracted';

  const title = sheet ? `Deal sheet: ${sheet.request.title}` : 'Deal sheet';
  const body = (
    <>
        {!sheet ? (
          error ? (
            <SectionMessage appearance="error">
              <Text>{error}</Text>
            </SectionMessage>
          ) : (
            <Spinner label="Loading deal sheet" />
          )
        ) : (
          <Stack space="space.200">
            <Stack space="space.075">
              <Inline space="space.100" alignBlock="center" shouldWrap>
                <StatusLozenge status={sheet.request.status} />
                {sheet.renegotiationContext ? <RenegotiationLozenge /> : null}
                {sheet.sameApproverAllowed ? <Lozenge appearance="moved">Demo: same approver allowed</Lozenge> : null}
              </Inline>
              <LinkedText
                text={
                  `${sheet.requester.name} asks ${sheet.provider.name} for size ${sheet.request.size}` +
                  `${sheet.request.minSize ? ` (minimum ${sheet.request.minSize})` : ''} by ${formatDate(sheet.request.neededBy)}, for ${sheet.request.sourceIssueKey ?? 'a restricted issue'}.`
                }
                keys={sheet.request.sourceIssueKey ? [sheet.request.sourceIssueKey] : []}
              />
              {sheet.renegotiationContext ? (
                <LinkedText text={sheet.renegotiationContext.text} keys={sheet.renegotiationContext.issueKeys} />
              ) : null}
              {sheet.options.length ? <SideStatusRow sheet={sheet} /> : null}
            </Stack>

            {error ? (
              <SectionMessage appearance="error">
                <Text>{error}</Text>
              </SectionMessage>
            ) : null}
            {message ? (
              <SectionMessage appearance="success">
                <Text>{message}</Text>
              </SectionMessage>
            ) : null}

            {status === 'negotiating' ? (
              <Inline space="space.100" alignBlock="center">
                <Spinner size="small" label="Negotiating" />
                <Text>{`The delegates are negotiating (round ${sheet.rounds.some((r) => r.roundNo === 2) ? 2 : 1} of 2)…`}</Text>
              </Inline>
            ) : null}
            {status === 'failed' ? (
              <SectionMessage appearance="error" title="Accord stopped">
                <Text>
                  {sheet.contract
                    ? 'Both leads approved, but Accord could not finish updating Jira after several attempts.'
                    : 'The negotiation stopped after several failed attempts, so no deal sheet was produced.'}
                  {sheet.canRetry ? ' Use "Retry" to start it again.' : ' A team lead or the requester can retry it.'}
                </Text>
              </SectionMessage>
            ) : (
              sheet.rounds
                .filter((r) => r.status === 'failed')
                .map((r) => (
                  <SectionMessage key={`${r.roundNo}-${r.role}`} appearance="warning">
                    <Text>{`Round ${r.roundNo} hit an error; Accord retries it automatically.`}</Text>
                  </SectionMessage>
                ))
            )}
            {exhausted ? (
              <SectionMessage appearance="information">
                <Inline space="space.100" alignBlock="center" shouldWrap>
                  <Text>Still working — this is taking longer than usual.</Text>
                  <Button
                    appearance="subtle"
                    onClick={() => {
                      restartPolling();
                      void load();
                    }}
                  >
                    Refresh
                  </Button>
                </Inline>
              </SectionMessage>
            ) : null}
            {sheet.canRetry ? (
              <Inline>
                <Button appearance="warning" isDisabled={busy} onClick={() => void retry()}>
                  Retry
                </Button>
              </Inline>
            ) : null}
            {status === 'approved' ? (
              <SectionMessage appearance="information" title="Both leads approved">
                <Inline space="space.100" alignBlock="center">
                  <Spinner size="small" label="Updating Jira" />
                  <Text>Accord is creating the deliverable, links, sprint moves and comments in Jira…</Text>
                </Inline>
              </SectionMessage>
            ) : null}
            {status === 'contracted' ? <AppliedChanges sheet={sheet} /> : null}
            {status === 'rejected' ? (
              <SectionMessage appearance="warning" title="Rejected">
                <Text>
                  {`${sheet.approvals.filter((a) => a.decision === 'reject').map((a) => a.reason).join('; ')}. The request can be resized, re-dated or escalated.`}
                </Text>
              </SectionMessage>
            ) : null}

            {featured ? (
              <Stack space="space.100">
                <Heading size="xsmall">{settled ? 'Agreed option' : 'Recommended option'}</Heading>
                <OptionCard
                  option={featured}
                  sheet={sheet}
                  busy={busy}
                  featured
                  onDecide={(chosen, side) => void decide(chosen, side, 'approve')}
                />
              </Stack>
            ) : null}

            {others.length ? (
              <Stack space="space.100">
                <Toggle
                  open={showOthers}
                  onToggle={() => setShowOthers((value) => !value)}
                  show={`Show other options (${others.length})`}
                  hide={`Hide other options (${others.length})`}
                />
                {showOthers
                  ? others.map((option) => (
                      <OptionCard
                        key={option.id}
                        option={option}
                        sheet={sheet}
                        busy={busy}
                        featured={false}
                        onDecide={(chosen, side) => void decide(chosen, side, 'approve')}
                      />
                    ))
                  : null}
              </Stack>
            ) : null}

            {sheet.canDecideAs.length && featured ? (
              <Stack space="space.100">
                <Heading size="xsmall">Reject instead</Heading>
                <Label labelFor="accord-reject-reason">Reason (required to reject)</Label>
                <TextArea id="accord-reject-reason" name="reason" onChange={(event) => setReason(event.target.value)} />
                <Inline space="space.100" shouldWrap>
                  {sheet.canDecideAs.map((side) => (
                    <Button
                      key={side}
                      appearance="danger"
                      isDisabled={busy || reason.trim() === ''}
                      onClick={() => void decide(featured, side, 'reject')}
                    >
                      {`Reject as ${teamName(sheet, side)} lead`}
                    </Button>
                  ))}
                </Inline>
                <Text color="color.text.subtle">
                  Both team leads must approve the same option. If you lead both teams, approve once for each team.
                </Text>
              </Stack>
            ) : null}

            {sheet.transcript.length ? (
              <Stack space="space.100">
                <Toggle
                  open={showTranscript}
                  onToggle={() => setShowTranscript((value) => !value)}
                  show="Show negotiation transcript"
                  hide="Hide negotiation transcript"
                />
                {showTranscript ? (
                  <Stack space="space.075">
                    {sheet.transcript.map((line, index) => (
                      <Text key={`line-${index}`}>
                        <Strong>{`Round ${line.round} · ${line.speaker}: `}</Strong>
                        {line.text}
                      </Text>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        )}
    </>
  );

  if (inline) {
    return (
      <Box xcss={cardStyle}>
        <Stack space="space.200">
          <Heading size="small">{title}</Heading>
          {body}
          <Inline>
            <Button appearance="subtle" onClick={onClose}>
              Hide deal sheet
            </Button>
          </Inline>
        </Stack>
      </Box>
    );
  }
  return (
    <Modal onClose={onClose} width="x-large">
      <ModalHeader>
        <ModalTitle>{title}</ModalTitle>
      </ModalHeader>
      <ModalBody>{body}</ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
