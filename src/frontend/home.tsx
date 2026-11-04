import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
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
} from '@forge/react';
import { invoke } from '@forge/bridge';

type Failure = { ok: false; error: string };

interface TeamView {
  teamKey: string;
  name: string;
  projectKey: string;
  boardId: number | null;
  charter: { status: 'none' | 'valid' | 'invalid'; missing: string[]; pageId: string | null; url: string | null };
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

const SEED_STEP_LABELS: Record<string, string> = {
  'project:MOB': 'Create Mobile project (MOB) with a Scrum board',
  'project:PAY': 'Create Payments project (PAY) with a Scrum board',
  'sprints:MOB': 'Mobile: active and next sprint with issues',
  'sprints:PAY': 'Payments: active and next sprint with issues',
  'charter:MOB': 'Mobile charter page in Confluence',
  'charter:PAY': 'Payments charter page in Confluence',
  history: 'Simulated throughput history (6 sprints per team)',
};

async function call<T>(key: string, payload?: Record<string, unknown>): Promise<({ ok: true } & T) | Failure> {
  try {
    const response = await invoke<({ ok: true } & T) | Failure>(key, payload);
    return 'body' in response ? response.body : response;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : `Request ${key} failed` };
  }
}

const CharterStatus = ({ charter }: { charter: TeamView['charter'] }) => {
  if (charter.status === 'valid') return <Lozenge appearance="success">Charter valid</Lozenge>;
  if (charter.status === 'invalid') {
    return (
      <Stack space="space.050">
        <Lozenge appearance="removed">Charter incomplete</Lozenge>
        <Text>Missing: {charter.missing.join(', ')}</Text>
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
          value={projectKey}
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

const DemoTab = ({ onSeeded }: { onSeeded: () => Promise<void> }) => {
  const [steps, setSteps] = useState<SeedStepStatus[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adoptExisting, setAdoptExisting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<{ steps: SeedStepStatus[] }>('getSeedStatus').then((result) =>
      result.ok ? setSteps(result.steps) : setError(result.error),
    );
  }, []);

  const seed = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setError(null);
    const order = Object.keys(SEED_STEP_LABELS);
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
        Creates two demo teams, Mobile (MOB) and Payments (PAY), with Scrum boards, an active and a next sprint full of
        issues, charter pages in Confluence, and six sprints of throughput stored as Simulated history. Running it again
        only adds what is missing. Accord never changes issues outside these two projects.
      </Text>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Checkbox
        name="adoptExisting"
        label="Use existing MOB and PAY projects (if a Jira admin created them manually)"
        isChecked={adoptExisting}
        onChange={() => setAdoptExisting((value) => !value)}
      />
      <ButtonGroup label="Demo actions">
        <Button appearance="primary" isDisabled={running} onClick={() => setConfirmOpen(true)}>
          Seed demo data
        </Button>
        <Button isDisabled>Add two critical bugs to Payments</Button>
        <Button isDisabled>Run daily monitor now</Button>
      </ButtonGroup>
      <Text>The last two buttons arrive with contract monitoring (milestone M4).</Text>
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
              { key: 'step', content: <Text>{SEED_STEP_LABELS[item.step] ?? item.step}</Text> },
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
                This creates the Jira projects MOB and PAY (if missing), sprints and issues in them, and two charter pages
                in the Confluence space ACCORD.
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
    </Stack>
  );
};

const App = () => {
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <Heading size="large">Accord</Heading>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Tabs id="accord-home-tabs">
        <TabList>
          <Tab>Inbox</Tab>
          <Tab>Contracts</Tab>
          <Tab>Teams</Tab>
          <Tab>Demo</Tab>
        </TabList>
        <TabPanel>
          <Text>Incoming dependency requests will appear here (milestone M3).</Text>
        </TabPanel>
        <TabPanel>
          <Text>Active contracts will appear here (milestone M3).</Text>
        </TabPanel>
        <TabPanel>
          <TeamsTab teams={teams} reload={reload} />
        </TabPanel>
        <TabPanel>
          <DemoTab onSeeded={reload} />
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
