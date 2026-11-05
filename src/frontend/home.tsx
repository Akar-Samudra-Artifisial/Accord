import React, { useCallback, useEffect, useRef, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  DynamicTable,
  Heading,
  Inline,
  Link,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  Tooltip,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { formatDate, formatDateRange, formatDateTime } from '../format/dates';
import { plural } from '../format/text';
import { DealSheetModal, EscalatedLozenge, RenegotiationLozenge, StatusLozenge, STATUS_LABEL, type RequestStatus } from './dealsheet';
import { changedKey, contractIsMoving, contractSignature, requestIsMoving, useBoundedPolling, useIdlePolling } from './polling';

type Failure = { ok: false; error: string };

interface TeamView {
  teamKey: string;
  name: string;
  projectKey: string;
  boardId: number | null;
  charter: {
    status: 'none' | 'valid' | 'invalid';
    missing: string[];
    pageId: string | null;
    url: string | null;
    ignoredApprovers: number;
    approversChangedAt: string | null;
  };
  capacity: {
    pessimistic: number;
    realistic: number;
    samples: number[];
    limitedData: boolean;
    source: 'jira' | 'simulated' | 'none';
    sourceLabel: string;
  };
}

interface SeedStepStatus {
  step: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
}

interface SeedPlan {
  projects: Array<{ slot: string; name: string; projectKey: string; state: 'create' | 'accord' | 'adopted' }>;
  space: { key: string; state: 'create' | 'accord' };
}

/** Step ids are `<kind>:<slot>`; labels show the project keys the seed actually uses. */
function seedStepLabel(step: string, plan: SeedPlan | null): string {
  if (step === 'history') return 'Simulated throughput history (6 sprints per team)';
  const [kind, slot] = step.split(':');
  const project = plan?.projects.find((item) => item.slot === slot);
  if (!project) return step;
  if (kind === 'project') {
    const verb = project.state === 'create' ? 'Create' : 'Use';
    return `${verb} ${project.name} project (${project.projectKey}) with a Scrum board`;
  }
  if (kind === 'sprints') return `${project.name} (${project.projectKey}): active and next sprint with issues`;
  if (kind === 'charter') return `${project.name} charter page in Confluence space ${plan?.space.key ?? ''}`;
  return step;
}

const listKeys = (keys: string[]) => keys.join(' and ');

interface DemoLeadState {
  canManage: boolean;
  projects: Array<{ projectKey: string; name: string; isLead: boolean }>;
}

async function call<T>(key: string, payload?: Record<string, unknown>): Promise<({ ok: true } & T) | Failure> {
  try {
    const response = await invoke<({ ok: true } & T) | Failure>(key, payload);
    return 'body' in response ? response.body : response;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `Request ${key} failed` };
  }
}

const ApproverNotes = ({ charter }: { charter: TeamView['charter'] }) => (
  <>
    {charter.ignoredApprovers > 0 ? (
      <Text>
        {`${plural(charter.ignoredApprovers, 'approver')} ignored: missing Browse projects or Schedule issues permission in Jira.`}
      </Text>
    ) : null}
    {charter.approversChangedAt ? (
      <Inline space="space.050">
        <Lozenge appearance="moved">Approvers changed</Lozenge>
        <Text>{formatDateTime(charter.approversChangedAt)}</Text>
      </Inline>
    ) : null}
  </>
);

const CharterStatus = ({ charter }: { charter: TeamView['charter'] }) => {
  if (charter.status === 'valid') {
    return (
      <Stack space="space.050">
        <Lozenge appearance="success">Charter valid</Lozenge>
        <ApproverNotes charter={charter} />
      </Stack>
    );
  }
  if (charter.status === 'invalid') {
    return (
      <Stack space="space.050">
        <Lozenge appearance="removed">Charter incomplete</Lozenge>
        <Text>Missing: {charter.missing.join(', ')}</Text>
        <ApproverNotes charter={charter} />
      </Stack>
    );
  }
  return <Lozenge appearance="default">No charter</Lozenge>;
};

const CapacityCell = ({ capacity }: { capacity: TeamView['capacity'] }) => {
  if (capacity.source === 'none') return <Lozenge appearance="moved">No history</Lozenge>;
  return (
    <Stack space="space.050">
      <Text>
        {capacity.pessimistic}–{capacity.realistic} issues per sprint
      </Text>
      <Inline space="space.050">
        {capacity.source === 'simulated' ? <Lozenge appearance="new">Simulated history</Lozenge> : null}
        {capacity.limitedData ? <Lozenge appearance="moved">Limited data</Lozenge> : null}
      </Inline>
    </Stack>
  );
};

const TeamsTab = ({ teams, reload }: { teams: TeamView[] | null; reload: () => Promise<void> }) => {
  const [projectKey, setProjectKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const run = async (label: string, key: string, payload: Record<string, unknown>, success: string) => {
    setBusy(label);
    setMessage(null);
    const result = await call<{ team: TeamView }>(key, payload);
    setMessage(result.ok ? { kind: 'success', text: success } : { kind: 'error', text: result.error });
    await reload();
    setBusy(null);
  };

  if (!teams) return <Spinner label="Loading teams" />;

  const head = {
    cells: [
      { key: 'team', content: 'Team' },
      { key: 'board', content: 'Scrum board' },
      { key: 'charter', content: 'Charter' },
      { key: 'capacity', content: 'Capacity (pessimistic–realistic)' },
      { key: 'actions', content: 'Actions' },
    ],
  };
  const rows = teams.map((team) => ({
    key: team.teamKey,
    cells: [
      { key: 'team', content: <Text>{`${team.name} (${team.projectKey})`}</Text> },
      { key: 'board', content: <Text>{team.boardId ? `Board ${team.boardId}` : 'None'}</Text> },
      { key: 'charter', content: <CharterStatus charter={team.charter} /> },
      { key: 'capacity', content: <CapacityCell capacity={team.capacity} /> },
      {
        key: 'actions',
        content: (
          <Inline space="space.100" alignBlock="center">
            {team.charter.url ? (
              <Link href={team.charter.url} openNewTab>
                Open charter
              </Link>
            ) : null}
            {team.charter.status === 'none' ? (
              <Button
                isDisabled={busy !== null}
                onClick={() => run(`charter-${team.teamKey}`, 'createCharterPage', { teamKey: team.teamKey }, `Charter page created for ${team.name}.`)}
              >
                Create charter page
              </Button>
            ) : (
              <Button
                isDisabled={busy !== null}
                onClick={() => run(`sync-${team.teamKey}`, 'syncCharter', { teamKey: team.teamKey }, `Charter of ${team.name} re-checked.`)}
              >
                Re-check charter
              </Button>
            )}
          </Inline>
        ),
      },
    ],
  }));

  return (
    <Stack space="space.200">
      <Text>
        A team is a Jira project with a Scrum board. Teams without a valid charter cannot receive dependency requests.
      </Text>
      {message ? (
        <SectionMessage appearance={message.kind === 'error' ? 'error' : 'success'}>
          <Text>{message.text}</Text>
        </SectionMessage>
      ) : null}
      <DynamicTable
        caption="Teams"
        head={head}
        rows={rows}
        emptyView={<Text>No teams yet. Add a Jira project below or seed the demo data.</Text>}
      />
      <Inline space="space.100" alignBlock="end">
        <Textfield
          name="projectKey"
          placeholder="Jira project key, for example PAY"
          aria-label="Jira project key"
          onChange={(event) => setProjectKey(event.target.value)}
        />
        <Button
          appearance="primary"
          isDisabled={busy !== null || projectKey.trim() === ''}
          onClick={() => run('register', 'registerTeam', { projectKey }, `Team ${projectKey.toUpperCase()} added.`)}
        >
          Add team
        </Button>
      </Inline>
      {busy ? <Spinner label="Working" /> : null}
    </Stack>
  );
};

const STATUS_LOZENGE: Record<SeedStepStatus['status'], { appearance: 'default' | 'inprogress' | 'success' | 'removed'; text: string }> = {
  pending: { appearance: 'default', text: 'Pending' },
  running: { appearance: 'inprogress', text: 'Running' },
  done: { appearance: 'success', text: 'Done' },
  failed: { appearance: 'removed', text: 'Failed' },
};

const DemoTab = ({ onSeeded, onMonitorQueued }: { onSeeded: () => Promise<void>; onMonitorQueued: () => void }) => {
  const [steps, setSteps] = useState<SeedStepStatus[] | null>(null);
  const [plan, setPlan] = useState<SeedPlan | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adoptExisting, setAdoptExisting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leadState, setLeadState] = useState<DemoLeadState | null>(null);
  const [seedBlocked, setSeedBlocked] = useState<string | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [notRestored, setNotRestored] = useState<string[]>([]);

  const cleanDemo = async () => {
    setCleanOpen(false);
    setAction('cleanDemoData');
    setError(null);
    setNotice(null);
    setNotRestored([]);
    const result = await call<{ summary: string; notRestored: string[] }>('cleanDemoData');
    if (!result.ok) setError(result.error);
    else {
      setNotice(result.summary);
      setNotRestored(result.notRestored);
      await onSeeded();
    }
    setAction(null);
  };

  const loadLeadState = async () => {
    const result = await call<DemoLeadState>('getDemoLeadState');
    if (result.ok) setLeadState(result);
  };

  useEffect(() => {
    call<{ steps: SeedStepStatus[]; plan: SeedPlan | null; canSeed: boolean; reason: string | null }>('getSeedStatus', { adoptExisting }).then(
      (result) => {
        if (!result.ok) return setError(result.error);
        setSteps(result.steps);
        setPlan(result.plan);
        setSeedBlocked(result.canSeed ? null : (result.reason ?? 'Only a Jira admin can seed the demo data.'));
      },
    );
  }, [adoptExisting]);

  useEffect(() => {
    void loadLeadState();
  }, []);

  const makeMeLead = async () => {
    setAction('makeMeDemoLead');
    setError(null);
    setNotice(null);
    const result = await call<{ results: Array<{ projectKey: string; leadChanged: boolean; approversChanged: boolean }> }>('makeMeDemoLead');
    if (!result.ok) setError(result.error);
    else {
      const changed = result.results.filter((item) => item.leadChanged || item.approversChanged).map((item) => item.projectKey);
      setNotice(
        changed.length
          ? `You are now the lead and charter approver of ${listKeys(result.results.map((item) => item.projectKey))}.`
          : 'You already are the lead and charter approver of the demo projects.',
      );
      await loadLeadState();
      await onSeeded();
    }
    setAction(null);
  };

  const demoAction = async (key: 'addDemoBugs' | 'resetDemoBugs' | 'runMonitorNow') => {
    setAction(key);
    setError(null);
    setNotice(null);
    const result = await call<{
      added?: string[];
      existing?: string[];
      moved?: string[];
      sprintName?: string | null;
      deliverableIssueKey?: string | null;
      queuedTeams?: number;
    }>(key);
    if (!result.ok) setError(result.error);
    else if (key === 'runMonitorNow') {
      setNotice(`Monitor queued for ${result.queuedTeams ?? 0} provider team(s). Open Contracts in a few seconds to see the result.`);
    } else if (key === 'addDemoBugs') {
      const added = result.added ?? [];
      const sprint = result.sprintName ?? 'the active Payments sprint';
      setNotice(
        added.length
          ? `Added ${plural(added.length, 'critical bug')} to ${sprint} — monitor running…`
          : `${sprint} already has enough critical bugs to put ${result.deliverableIssueKey ?? 'the contract'} at risk — monitor running…`,
      );
    } else {
      const moved = result.moved ?? [];
      setNotice(
        moved.length
          ? `Moved ${moved.length} demo bug${moved.length === 1 ? '' : 's'} to the Payments backlog — monitor running…`
          : 'There are no demo bugs to reset — monitor running…',
      );
    }
    // Every demo action queues the monitor; Contracts follows it until a row changes.
    if (result.ok) onMonitorQueued();
    setAction(null);
  };

  const seed = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setError(null);
    const order = (steps ?? []).map((item) => item.step);
    for (const step of order) {
      setSteps((current) => (current ?? []).map((item) => (item.step === step ? { ...item, status: 'running' } : item)));
      const result = await call<{ success: boolean; steps: SeedStepStatus[] }>('runSeedStep', { step, adoptExisting });
      if (!result.ok) {
        setError(result.error);
        break;
      }
      setSteps(result.steps);
      if (!result.success) break;
    }
    setRunning(false);
    await onSeeded();
  };

  return (
    <Stack space="space.200">
      <Text>
        {`Creates two demo teams, ${listKeys((plan?.projects ?? []).map((p) => `${p.name} (${p.projectKey})`)) || 'Mobile and Payments'}, `}
        with Scrum boards, an active and a next sprint full of issues, charter pages in Confluence, and six sprints of
        throughput stored as Simulated history. Running it again only adds what is missing. Accord never changes issues
        outside these two projects; when a preferred key is already used by another project, Accord picks a free one.
      </Text>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Checkbox
        name="adoptExisting"
        label={`Use existing ${listKeys((plan?.projects ?? []).map((p) => p.slot)) || 'demo'} projects (if a Jira admin created them manually)`}
        isChecked={adoptExisting}
        onChange={() => setAdoptExisting((value) => !value)}
      />
      <ButtonGroup label="Demo actions">
        <Button appearance="primary" isDisabled={running || action !== null || seedBlocked !== null} onClick={() => setConfirmOpen(true)}>
          Seed demo data
        </Button>
        <Button isDisabled={running || action !== null} onClick={() => void demoAction('addDemoBugs')}>
          Add critical bugs to Payments
        </Button>
        <Button isDisabled={running || action !== null} onClick={() => void demoAction('runMonitorNow')}>
          Run daily monitor now
        </Button>
        <Button appearance="subtle" isDisabled={running || action !== null} onClick={() => void demoAction('resetDemoBugs')}>
          Reset demo bugs
        </Button>
        {leadState?.canManage ? (
          <Button isDisabled={running || action !== null} onClick={() => void makeMeLead()}>
            Make me the demo lead
          </Button>
        ) : null}
        {leadState?.canManage ? (
          <Button appearance="warning" isDisabled={running || action !== null} onClick={() => setCleanOpen(true)}>
            Clean demo data
          </Button>
        ) : null}
      </ButtonGroup>
      {seedBlocked ? <Text color="color.text.subtle">{seedBlocked}</Text> : null}
      {leadState?.canManage ? (
        <Text>
          {`Demo project lead: ${leadState.projects.map((p) => `${p.projectKey} ${p.isLead ? '(you)' : '(someone else)'}`).join(', ')}. "Make me the demo lead" changes only the Accord demo projects.`}
        </Text>
      ) : null}
      <Text>
        Scenario: Accord adds just enough Highest-priority bugs to the active Payments sprint to push the nearest Payments
        contract past its agreed date (at most 8), then runs the monitor. The contract turns At risk and both issues get
        one comment. Reset moves the demo bugs to the backlog (they are not deleted) and runs the monitor again, so the
        contract recovers.
      </Text>
      {action ? <Spinner label="Working" /> : null}
      {notice ? (
        <SectionMessage appearance="success">
          <Text>{notice}</Text>
          {notRestored.map((item) => (
            <Text key={item}>{`Not restored: ${item}`}</Text>
          ))}
        </SectionMessage>
      ) : null}
      {steps ? (
        <DynamicTable
          caption="Seed steps"
          head={{
            cells: [
              { key: 'step', content: 'Step' },
              { key: 'status', content: 'Status' },
              { key: 'detail', content: 'Detail' },
            ],
          }}
          rows={steps.map((item) => ({
            key: item.step,
            cells: [
              { key: 'step', content: <Text>{seedStepLabel(item.step, plan)}</Text> },
              {
                key: 'status',
                content: <Lozenge appearance={STATUS_LOZENGE[item.status].appearance}>{STATUS_LOZENGE[item.status].text}</Lozenge>,
              },
              { key: 'detail', content: <Text>{item.detail ?? ''}</Text> },
            ],
          }))}
        />
      ) : (
        <Spinner label="Loading seed status" />
      )}
      <ModalTransition>
        {confirmOpen ? (
          <Modal onClose={() => setConfirmOpen(false)}>
            <ModalHeader>
              <ModalTitle>Seed demo data?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Text>
                {`This creates the Jira projects ${listKeys((plan?.projects ?? []).map((p) => p.projectKey))} (if missing), sprints and issues in them, and two charter pages in the Confluence space ${plan?.space.key ?? ''}.`}
              </Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={seed}>
                Seed demo data
              </Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
      <ModalTransition>
        {cleanOpen ? (
          <Modal onClose={() => setCleanOpen(false)}>
            <ModalHeader>
              <ModalTitle>Clean demo data?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Text>
                {`This deletes every request, contract, renegotiation and escalation between ${listKeys((leadState?.projects ?? []).map((p) => p.projectKey)) || 'the demo projects'}, moves the demo bugs to the backlog, archives the deliverables Accord created, removes the blocks links it added and the comments the Accord app posted on demo issues. Issues and comments written by people are never deleted. Older audit events are hidden from the Audit tab but kept in storage.`}
              </Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setCleanOpen(false)}>
                Cancel
              </Button>
              <Button appearance="warning" onClick={cleanDemo}>
                Clean demo data
              </Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
};

interface RequestSummary {
  id: string;
  title: string;
  status: RequestStatus;
  sourceIssueKey: string;
  neededBy: string;
  requester: string;
  provider: string;
  pendingFor: Array<'requester' | 'provider'>;
  renegotiation: boolean;
  escalatedTo: string[];
}

/** Shared props of the live tabs: whether the tab is shown and when the user last interacted. */
interface LiveTabProps {
  active: boolean;
  lastActivityAt: number;
}

/**
 * `watch` increases after a decision or a demo action: the Inbox then polls until its list changes (the
 * monitor may open a renegotiation), and also while an at-risk contract still waits for its renegotiation.
 */
const InboxTab = ({ onChanged, active, lastActivityAt, watch }: LiveTabProps & { onChanged: () => void; watch: number }) => {
  const [items, setItems] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(0);
  const [itemsKey, setItemsKey] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const shownKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    const result = await call<{ items: RequestSummary[]; awaitingRenegotiation?: number }>('getInbox');
    if (result.ok) {
      // Same data → no state change, so background refreshes do not flicker.
      const key = changedKey(shownKey.current, result.items);
      if (key !== null) {
        shownKey.current = key;
        setItems(result.items);
        setItemsKey(key);
      }
      setAwaiting(result.awaitingRenegotiation ?? 0);
      setError(null);
    } else setError(result.error);
  }, []);

  // "Approved, updating Jira" and "Negotiating" settle in the background queue; an at-risk contract
  // gets its renegotiation from the monitor queue.
  const watching = baseline !== null && itemsKey === baseline;
  const moving = (items?.some((item) => requestIsMoving(item.status)) ?? false) || awaiting > 0 || watching;
  const { polling, exhausted, restart } = useBoundedPolling(moving, load);
  useEffect(() => {
    if (watch === 0) return;
    setBaseline(shownKey.current ?? '');
    restart();
  }, [watch, restart]);
  // New requests (e.g. created by the Delegate agent) appear without a manual Refresh; also after the
  // fast polling budget is used up while something is still moving.
  useIdlePolling(active && !polling, lastActivityAt, load);
  const refresh = useCallback(() => {
    restart();
    void load();
  }, [restart, load]);

  // Initial load, and again each time the tab is selected (only `active` should retrigger this).
  useEffect(() => {
    if (active || items === null) refresh();
  }, [active]);

  if (error) {
    return (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!items) return <Spinner label="Loading inbox" />;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text>Requests where you are an approver for one of the teams. Requests waiting for your decision come first.</Text>
        {polling ? <Spinner size="small" label="Updating status" /> : null}
        {exhausted ? <Text color="color.text.subtle">Still working in the background.</Text> : null}
        <Button appearance="subtle" onClick={refresh}>
          Refresh
        </Button>
      </Inline>
      <DynamicTable
        caption="Inbox"
        head={{
          cells: [
            { key: 'request', content: 'Request' },
            { key: 'teams', content: 'Teams' },
            { key: 'needed', content: 'Needed by' },
            { key: 'status', content: 'Status' },
            { key: 'action', content: 'Action' },
          ],
        }}
        rows={items.map((item) => ({
          key: item.id,
          cells: [
            { key: 'request', content: <Text>{`${item.title} (${item.sourceIssueKey})`}</Text> },
            { key: 'teams', content: <Text>{`${item.requester} → ${item.provider}`}</Text> },
            { key: 'needed', content: <Text>{formatDate(item.neededBy)}</Text> },
            {
              key: 'status',
              content: (
                <Inline space="space.050" shouldWrap>
                  <StatusLozenge status={item.status} />
                  {item.renegotiation ? <RenegotiationLozenge /> : null}
                  {item.escalatedTo.length ? <EscalatedLozenge /> : null}
                  {item.pendingFor.length ? <Lozenge appearance="new">Your decision</Lozenge> : null}
                  {item.escalatedTo.length ? <Text color="color.text.subtle">{`to ${item.escalatedTo.join(', ')}`}</Text> : null}
                </Inline>
              ),
            },
            { key: 'action', content: <Button onClick={() => setOpen(item.id)}>Open deal sheet</Button> },
          ],
        }))}
        emptyView={<Text>No requests need you right now.</Text>}
      />
      <ModalTransition>
        {open ? (
          <DealSheetModal
            requestId={open}
            onChanged={() => {
              refresh();
              onChanged();
            }}
            onClose={() => {
              setOpen(null);
              refresh();
            }}
          />
        ) : null}
      </ModalTransition>
    </Stack>
  );
};

interface ContractRow {
  contractId: number;
  title: string;
  requester: string;
  provider: string;
  /** Null when the viewer cannot browse the issue (redacted). */
  sourceIssueKey: string | null;
  deliverableIssueKey: string | null;
  deliverableRestricted: boolean;
  agreedDateMin: string;
  agreedDateMax: string;
  projectedDate: string | null;
  status: 'applying' | 'on-track' | 'at-risk' | 'unknown' | 'superseded';
  /** This contract came out of a renegotiation (FR-14). */
  renegotiation: boolean;
  latestRenegotiation: { requestId: string; status: RequestStatus } | null;
  supersededBy: { requestId: string; contractId: number; agreedDateMin: string; agreedDateMax: string } | null;
  escalatedTo: string[];
}

const CONTRACT_STATUS: Record<ContractRow['status'], { text: string; appearance: 'inprogress' | 'success' | 'removed' | 'default' | 'moved' }> = {
  applying: { text: 'Updating Jira', appearance: 'inprogress' },
  'on-track': { text: 'On track', appearance: 'success' },
  'at-risk': { text: 'At risk', appearance: 'removed' },
  unknown: { text: 'Not enough data', appearance: 'default' },
  superseded: { text: 'Superseded', appearance: 'moved' },
};

/** Renegotiation still in progress for a contract (shown next to its status). */
const OPEN_RENEGOTIATION: readonly RequestStatus[] = ['negotiating', 'awaiting-approval', 'approved'];

interface DependencySummary {
  from: string;
  to: string;
  contracts: number;
  atRisk: number;
}

/**
 * `watch` increases after a decision or a demo action: the tab then polls until a contract row
 * changes (status or projected date), besides polling while a row is still being applied/evaluated.
 */
const ContractsTab = ({ watch, active, lastActivityAt }: LiveTabProps & { watch: number }) => {
  const [rows, setRows] = useState<ContractRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<DependencySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const shownKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    const result = await call<{ contracts: ContractRow[]; dependencies: DependencySummary[] }>('getContracts');
    if (result.ok) {
      // Same data → no state change, so background refreshes do not flicker.
      const key = changedKey(shownKey.current, [result.contracts, result.dependencies]);
      if (key !== null) {
        shownKey.current = key;
        setRows(result.contracts);
        setDependencies(result.dependencies);
      }
      setError(null);
    } else setError(result.error);
  }, []);

  const signature = rows ? contractSignature(rows) : null;
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const watching = baseline !== null && signature === baseline;
  const moving = (rows?.some((row) => contractIsMoving(row)) ?? false) || watching;
  const { polling, exhausted, restart } = useBoundedPolling(moving, load);

  useEffect(() => {
    if (watch === 0) return;
    setBaseline(signatureRef.current ?? '');
    restart();
  }, [watch, restart]);

  useIdlePolling(active && !moving, lastActivityAt, load);
  const refresh = useCallback(() => {
    restart();
    void load();
  }, [restart, load]);

  // Initial load, and again each time the tab is selected (only `active` should retrigger this).
  useEffect(() => {
    if (active || rows === null) refresh();
  }, [active]);

  if (error) {
    return (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!rows) return <Spinner label="Loading contracts" />;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Text>The daily monitor recalculates each projected date against the provider's open sprint work.</Text>
        {polling ? <Spinner size="small" label="Updating contracts" /> : null}
        {exhausted ? <Text color="color.text.subtle">Still working in the background.</Text> : null}
        <Button onClick={refresh}>Refresh</Button>
      </Inline>
      <DynamicTable
        caption="Contracts"
        head={{
          cells: [
            { key: 'contract', content: 'Contract' },
            { key: 'teams', content: 'Requester → provider' },
            { key: 'issues', content: 'Issues' },
            { key: 'agreed', content: 'Agreed dates' },
            { key: 'projected', content: 'Projected' },
            { key: 'status', content: 'Status' },
          ],
        }}
        rows={rows.map((row) => ({
          key: String(row.contractId),
          cells: [
            { key: 'contract', content: <Text>{row.title}</Text> },
            { key: 'teams', content: <Text>{`${row.requester} → ${row.provider}`}</Text> },
            {
              key: 'issues',
              content: (
                <Text>{`${row.deliverableIssueKey ?? (row.deliverableRestricted ? 'Restricted' : 'pending')} blocks ${row.sourceIssueKey ?? 'Restricted'}`}</Text>
              ),
            },
            { key: 'agreed', content: <Text>{formatDateRange(row.agreedDateMin, row.agreedDateMax)}</Text> },
            {
              key: 'projected',
              content: (
                <Text>
                  {row.projectedDate
                    ? formatDate(row.projectedDate)
                    : row.status === 'at-risk'
                      ? 'Beyond planning horizon'
                      : row.status === 'unknown'
                        ? 'Not enough data'
                        : 'Not evaluated yet'}
                </Text>
              ),
            },
            {
              key: 'status',
              content: (
                <Stack space="space.050">
                  <Inline space="space.050" shouldWrap>
                    <Lozenge appearance={CONTRACT_STATUS[row.status].appearance}>{CONTRACT_STATUS[row.status].text}</Lozenge>
                    {row.renegotiation ? <RenegotiationLozenge /> : null}
                    {row.escalatedTo.length ? <EscalatedLozenge /> : null}
                  </Inline>
                  {row.supersededBy ? (
                    <Button appearance="subtle" spacing="compact" onClick={() => setOpen(row.supersededBy?.requestId ?? null)}>
                      {`Superseded by the contract agreed ${formatDateRange(row.supersededBy.agreedDateMin, row.supersededBy.agreedDateMax)}`}
                    </Button>
                  ) : null}
                  {row.status !== 'superseded' && row.latestRenegotiation && OPEN_RENEGOTIATION.includes(row.latestRenegotiation.status) ? (
                    <Button appearance="subtle" spacing="compact" onClick={() => setOpen(row.latestRenegotiation?.requestId ?? null)}>
                      {`Renegotiation: ${STATUS_LABEL[row.latestRenegotiation.status].text.toLowerCase()}`}
                    </Button>
                  ) : null}
                  {row.escalatedTo.length ? <Text color="color.text.subtle">{`Escalated to ${row.escalatedTo.join(', ')}`}</Text> : null}
                </Stack>
              ),
            },
          ],
        }))}
        emptyView={<Text>No contracts yet. A contract appears after both team leads approve a deal sheet.</Text>}
      />
      <ModalTransition>
        {open ? (
          <DealSheetModal
            requestId={open}
            onChanged={refresh}
            onClose={() => {
              setOpen(null);
              refresh();
            }}
          />
        ) : null}
      </ModalTransition>
      <DynamicTable
        caption="Dependencies between teams"
        head={{
          cells: [
            { key: 'from', content: 'Depends (requester)' },
            { key: 'to', content: 'On (provider)' },
            { key: 'contracts', content: 'Contracts' },
            { key: 'risk', content: 'At risk' },
          ],
        }}
        rows={dependencies.map((dep) => ({
          key: `${dep.from}>${dep.to}`,
          cells: [
            { key: 'from', content: <Text>{dep.from}</Text> },
            { key: 'to', content: <Text>{dep.to}</Text> },
            { key: 'contracts', content: <Text>{String(dep.contracts)}</Text> },
            {
              key: 'risk',
              content: dep.atRisk ? <Lozenge appearance="removed">{`${dep.atRisk} at risk`}</Lozenge> : <Text>0</Text>,
            },
          ],
        }))}
        emptyView={<Text>No dependencies recorded yet.</Text>}
      />
    </Stack>
  );
};

type NetworkTeamStatus = Exclude<ContractRow['status'], 'superseded'> | 'none';

interface NetworkTeam {
  teamKey: string | null;
  name: string;
  worstStatus: NetworkTeamStatus;
  contracts: number;
  atRisk: number;
  /** Renegotiations in progress; `renegotiationHistory` counts all ever opened. */
  renegotiations: number;
  renegotiationHistory: number;
  escalations: number;
}

/** "1 open renegotiation, 0 escalations" with the full history in a tooltip. */
const RenegotiationCounts = ({ open, history, escalations, tone }: { open: number; history: number; escalations: number; tone?: 'color.text.subtle' | 'color.text.subtlest' }) => (
  <Tooltip content={`${plural(history, 'renegotiation')} opened in total`}>
    <Text color={tone}>{`${plural(open, 'open renegotiation')}, ${plural(escalations, 'escalation')}`}</Text>
  </Tooltip>
);

interface NetworkEdge {
  contractId: number;
  requestId: string;
  title: string;
  requester: string;
  provider: string;
  sourceIssueKey: string | null;
  deliverableIssueKey: string | null;
  deliverableRestricted: boolean;
  agreedDateMin: string;
  agreedDateMax: string;
  projectedDate: string | null;
  status: ContractRow['status'];
  dimmed: boolean;
  renegotiations: number;
  renegotiationHistory: number;
  escalations: number;
}

const TEAM_STATUS = (status: NetworkTeamStatus) =>
  status === 'none' ? { text: 'No active contracts', appearance: 'default' as const } : CONTRACT_STATUS[status];

const teamCardStyle = xcss({
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'radius.medium',
  padding: 'space.200',
  minWidth: '220px',
});

const IssueLink = ({ issueKey }: { issueKey: string }) => (
  <Link href={`/browse/${issueKey}`} openNewTab>
    {issueKey}
  </Link>
);

/** FR-17: teams with their worst contract status, and every visible contract as a requester → provider edge. */
const NetworkTab = ({ active }: { active: boolean }) => {
  const [map, setMap] = useState<{ teams: NetworkTeam[]; edges: NetworkEdge[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const result = await call<{ map: { teams: NetworkTeam[]; edges: NetworkEdge[] } }>('getDependencyMap');
    setRefreshing(false);
    if (result.ok) {
      setMap(result.map);
      setError(null);
    } else setError(result.error);
  }, []);

  // Reload each time the tab is selected.
  useEffect(() => {
    if (active || map === null) void load();
  }, [active]);

  if (error) {
    return (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!map) return <Spinner label="Loading dependency network" />;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Text>Teams linked by the contracts you can see. Superseded contracts are greyed out and do not count.</Text>
        <Button isDisabled={refreshing} onClick={() => void load()}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </Inline>
      {map.teams.length === 0 ? <Text>No dependencies recorded yet. Teams appear here once a contract is agreed.</Text> : null}
      <Inline space="space.200" shouldWrap>
        {map.teams.map((team) => (
          <Box key={team.teamKey ?? team.name} xcss={teamCardStyle}>
            <Stack space="space.100">
              <Heading size="small">{team.name}</Heading>
              <Lozenge appearance={TEAM_STATUS(team.worstStatus).appearance}>{TEAM_STATUS(team.worstStatus).text}</Lozenge>
              <Text>{`${plural(team.contracts, 'active contract')}, ${team.atRisk} at risk`}</Text>
              <RenegotiationCounts
                open={team.renegotiations}
                history={team.renegotiationHistory}
                escalations={team.escalations}
                tone="color.text.subtle"
              />
            </Stack>
          </Box>
        ))}
      </Inline>
      <DynamicTable
        caption="Dependencies"
        head={{
          cells: [
            { key: 'teams', content: 'Requester → provider' },
            { key: 'deliverable', content: 'Deliverable' },
            { key: 'status', content: 'Status' },
            { key: 'agreed', content: 'Agreed dates' },
            { key: 'projected', content: 'Projected' },
            { key: 'history', content: 'Renegotiations' },
          ],
        }}
        rows={map.edges.map((edge) => {
          const tone = edge.dimmed ? 'color.text.subtlest' : undefined;
          return {
            key: String(edge.contractId),
            cells: [
              { key: 'teams', content: <Text color={tone}>{`${edge.requester} → ${edge.provider}`}</Text> },
              {
                key: 'deliverable',
                content: (
                  <Stack space="space.050">
                    <Text color={tone}>{edge.title}</Text>
                    <Inline space="space.050">
                      {edge.deliverableIssueKey ? (
                        <IssueLink issueKey={edge.deliverableIssueKey} />
                      ) : (
                        <Text color="color.text.subtle">{edge.deliverableRestricted ? 'Restricted' : 'pending'}</Text>
                      )}
                      <Text color="color.text.subtle">blocks</Text>
                      {edge.sourceIssueKey ? <IssueLink issueKey={edge.sourceIssueKey} /> : <Text color="color.text.subtle">Restricted</Text>}
                    </Inline>
                  </Stack>
                ),
              },
              {
                key: 'status',
                content: <Lozenge appearance={CONTRACT_STATUS[edge.status].appearance}>{CONTRACT_STATUS[edge.status].text}</Lozenge>,
              },
              { key: 'agreed', content: <Text color={tone}>{formatDateRange(edge.agreedDateMin, edge.agreedDateMax)}</Text> },
              { key: 'projected', content: <Text color={tone}>{edge.projectedDate ? formatDate(edge.projectedDate) : '—'}</Text> },
              {
                key: 'history',
                content:
                  edge.renegotiationHistory || edge.escalations ? (
                    <RenegotiationCounts
                      open={edge.renegotiations}
                      history={edge.renegotiationHistory}
                      escalations={edge.escalations}
                      tone={edge.dimmed ? 'color.text.subtlest' : undefined}
                    />
                  ) : (
                    <Text color={tone}>—</Text>
                  ),
              },
            ],
          };
        })}
        emptyView={<Text>No contracts to show.</Text>}
      />
    </Stack>
  );
};

interface AuditRow {
  id: number;
  at: string;
  subject: string;
  action: string;
  actor: string;
  summary: string;
}

const AuditTab = () => {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on every load: the table is remounted, because it did not show new rows on Refresh.
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    const result = await call<{ entries: AuditRow[] }>('getAudit');
    setRefreshing(false);
    if (result.ok) {
      setRows(result.entries);
      setVersion((value) => value + 1);
      setError(null);
    } else setError(result.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!rows) return <Spinner label="Loading audit trail" />;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Text>Recent decisions and background steps for the teams you can access.</Text>
        <Button isDisabled={refreshing} onClick={() => void load()}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </Inline>
      <DynamicTable
        key={version}
        caption="Audit trail"
        head={{
          cells: [
            { key: 'at', content: 'When (UTC)' },
            { key: 'subject', content: 'Request' },
            { key: 'action', content: 'Event' },
            { key: 'actor', content: 'By' },
            { key: 'summary', content: 'Details' },
          ],
        }}
        rows={rows.map((row) => ({
          key: String(row.id),
          cells: [
            { key: 'at', content: <Text>{formatDateTime(row.at)}</Text> },
            { key: 'subject', content: <Text>{row.subject}</Text> },
            { key: 'action', content: <Text>{row.action}</Text> },
            { key: 'actor', content: <Text>{row.actor}</Text> },
            { key: 'summary', content: <Text>{row.summary || '—'}</Text> },
          ],
        }))}
        emptyView={<Text>No audit entries yet.</Text>}
      />
    </Stack>
  );
};

const App = () => {
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState(0);
  const [tab, setTab] = useState(0);
  // Tab switches, decisions and demo actions count as interaction and extend the idle refresh window.
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const watchContracts = useCallback(() => {
    setWatch((value) => value + 1);
    setLastActivityAt(Date.now());
  }, []);
  const selectTab = useCallback((index: number) => {
    setTab(index);
    setLastActivityAt(Date.now());
  }, []);

  const reload = useCallback(async () => {
    const result = await call<{ teams: TeamView[] }>('getTeams');
    if (result.ok) {
      setTeams(result.teams);
      setError(null);
    } else {
      setError(result.error);
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Stack space="space.200">
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Tabs id="accord-home-tabs" onChange={selectTab}>
        <TabList>
          <Tab>Inbox</Tab>
          <Tab>Contracts</Tab>
          <Tab>Network</Tab>
          <Tab>Teams</Tab>
          <Tab>Audit</Tab>
          <Tab>Demo</Tab>
        </TabList>
        <TabPanel>
          <InboxTab onChanged={watchContracts} active={tab === 0} lastActivityAt={lastActivityAt} watch={watch} />
        </TabPanel>
        <TabPanel>
          <ContractsTab watch={watch} active={tab === 1} lastActivityAt={lastActivityAt} />
        </TabPanel>
        <TabPanel>
          <NetworkTab active={tab === 2} />
        </TabPanel>
        <TabPanel>
          <TeamsTab teams={teams} reload={reload} />
        </TabPanel>
        <TabPanel>
          <AuditTab />
        </TabPanel>
        <TabPanel>
          <DemoTab onSeeded={reload} onMonitorQueued={watchContracts} />
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
