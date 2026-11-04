import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  DatePicker,
  ErrorMessage,
  Form,
  FormFooter,
  FormHeader,
  FormSection,
  HelperMessage,
  Inline,
  Label,
  ModalTransition,
  RequiredAsterisk,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
  useForm,
} from '@forge/react';
import { call, DealSheetModal, StatusLozenge, type RequestStatus } from './dealsheet';

interface RequestSummary {
  id: string;
  title: string;
  status: RequestStatus;
  sourceIssueKey: string;
  neededBy: string;
  requester: string;
  provider: string;
  pendingFor: Array<'requester' | 'provider'>;
}

interface PanelState {
  issueKey: string;
  requesterTeam: { teamKey: string; name: string } | null;
  providerTeams: Array<{ teamKey: string; name: string }>;
  requests: RequestSummary[];
}

interface Choice {
  label: string;
  value: string;
}

interface RequestFormValues {
  provider: Choice | null;
  title: string;
  size: Choice;
  minSize: string;
  neededBy: string;
  costClass: Choice;
}

const SIZE_CHOICES: Choice[] = [
  { label: 'S (1 issue)', value: 'S' },
  { label: 'M (3 issues)', value: 'M' },
  { label: 'L (6 issues)', value: 'L' },
];

const COST_CHOICES: Choice[] = [
  { label: 'Standard (linked to an active quarter goal)', value: 'standard' },
  { label: 'Fixed date (dated release, contract or regulation)', value: 'fixed-date' },
  { label: 'Intangible (not linked to an active goal)', value: 'intangible' },
];

/** Statuses that still change without user action (background queue). */
const MOVING: ReadonlySet<RequestStatus> = new Set(['negotiating', 'approved']);
const POLL_MS = 4000;
const MAX_POLLS = 30;

/**
 * Uncontrolled form (UI Kit `useForm`): typing does not round-trip through React state,
 * so fast typing never drops characters.
 */
const RequestForm = ({
  state,
  onCreated,
  onCancel,
}: {
  state: PanelState;
  onCreated: (requestId: string) => void;
  onCancel?: () => void;
}) => {
  const providers = state.providerTeams.map((team) => ({ label: `${team.name} (${team.teamKey})`, value: team.teamKey }));
  const { handleSubmit, register, getFieldId, formState } = useForm<RequestFormValues>({
    defaultValues: {
      provider: providers[0] ?? null,
      title: '',
      size: SIZE_CHOICES[1],
      minSize: '',
      // No neededBy default: an empty string makes the DatePicker show a bogus date.
      costClass: COST_CHOICES[0],
    },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { errors } = formState;

  const submit = async (values: RequestFormValues) => {
    setBusy(true);
    setError(null);
    const result = await call<{ requestId: string }>('createRequest', {
      sourceIssueKey: state.issueKey,
      providerTeamKey: values.provider?.value,
      title: values.title,
      size: values.size?.value,
      minSize: values.minSize.trim() === '' ? null : values.minSize.trim(),
      neededBy: values.neededBy ?? '',
      costClass: values.costClass?.value,
    });
    setBusy(false);
    if (result.ok) onCreated(result.requestId);
    else setError(result.error);
  };

  if (!state.requesterTeam) {
    return <Text>This project is not an Accord team yet. Add it in Apps → Accord → Teams to request work from other teams.</Text>;
  }
  if (providers.length === 0) return <Text>No other team with a valid charter can receive requests yet.</Text>;

  return (
    <Form onSubmit={handleSubmit(submit)}>
      <FormHeader title="Request work with Accord">
        <Text>Both team delegates negotiate first. Nothing changes in Jira until both team leads approve.</Text>
      </FormHeader>
      <FormSection>
        <Stack space="space.100">
          {error ? (
            <SectionMessage appearance="error">
              <Text>{error}</Text>
            </SectionMessage>
          ) : null}
          <Label labelFor={getFieldId('provider')}>
            Team to ask
            <RequiredAsterisk />
          </Label>
          <Select {...register('provider', { required: true })} inputId={getFieldId('provider')} options={providers} />
          <Label labelFor={getFieldId('title')}>
            What do you need?
            <RequiredAsterisk />
          </Label>
          <Textfield {...register('title', { required: true, validate: (value) => typeof value === 'string' && value.trim() !== '' })} />
          {errors.title ? <ErrorMessage>Describe the work you need, for example "Refund API".</ErrorMessage> : null}
          <Label labelFor={getFieldId('size')}>Size</Label>
          <Select {...register('size')} inputId={getFieldId('size')} options={SIZE_CHOICES} />
          <Label labelFor={getFieldId('minSize')}>Minimum useful part (optional)</Label>
          <Textfield {...register('minSize')} type="number" />
          <HelperMessage>Number of issues that would already unblock you.</HelperMessage>
          <Label labelFor={getFieldId('neededBy')}>
            Needed by
            <RequiredAsterisk />
          </Label>
          <DatePicker {...register('neededBy', { required: true })} />
          {errors.neededBy ? <ErrorMessage>Pick the date you need the work by.</ErrorMessage> : null}
          <Label labelFor={getFieldId('costClass')}>Cost of delay</Label>
          <Select {...register('costClass')} inputId={getFieldId('costClass')} options={COST_CHOICES} />
        </Stack>
      </FormSection>
      <FormFooter align="start">
        <Inline space="space.100" alignBlock="center">
          <Button type="submit" appearance="primary" isDisabled={busy}>
            Send request
          </Button>
          {onCancel ? (
            <Button appearance="subtle" isDisabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {busy ? <Spinner label="Sending request" /> : null}
        </Inline>
      </FormFooter>
    </Form>
  );
};

const App = () => {
  const [state, setState] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [polls, setPolls] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const result = await call<PanelState>('getPanelState');
    if (result.ok) {
      setState(result);
      setError(null);
    } else setError(result.error);
  }, []);

  /** Manual or event-driven refresh; restarts the bounded polling budget. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setPolls(0);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // Badges follow the background negotiation without a page reload (bounded).
  const moving = state?.requests.some((request) => MOVING.has(request.status)) ?? false;
  useEffect(() => {
    if (!moving || polls >= MAX_POLLS) return undefined;
    const timer = setTimeout(() => {
      setPolls((value) => value + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [moving, polls, load]);

  if (error) {
    return (
      <SectionMessage appearance="error">
        <Stack space="space.100">
          <Text>{error}</Text>
          <Inline>
            <Button onClick={() => void refresh()}>Try again</Button>
          </Inline>
        </Stack>
      </SectionMessage>
    );
  }
  if (!state) return <Spinner label="Loading Accord" />;

  return (
    <Stack space="space.200">
      {state.requests.map((request) => (
        <Stack key={request.id} space="space.050">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <StatusLozenge status={request.status} />
            <Text weight="medium">{request.title}</Text>
          </Inline>
          <Text color="color.text.subtle">{`${request.requester} → ${request.provider} · needed by ${request.neededBy}`}</Text>
          {request.pendingFor.length ? <Text weight="bold">Your decision is needed.</Text> : null}
          <Inline>
            <Button onClick={() => setOpenRequest(request.id)}>Open deal sheet</Button>
          </Inline>
        </Stack>
      ))}
      {state.requests.length ? (
        <Inline space="space.100" alignBlock="center" shouldWrap>
          {moving && polls < MAX_POLLS ? <Spinner size="small" label="Updating status" /> : null}
          {moving && polls >= MAX_POLLS ? <Text color="color.text.subtle">Still working in the background.</Text> : null}
          <Button appearance="subtle" isDisabled={refreshing} onClick={() => void refresh()}>
            Refresh
          </Button>
        </Inline>
      ) : null}
      {showForm || state.requests.length === 0 ? (
        <RequestForm
          state={state}
          onCancel={state.requests.length ? () => setShowForm(false) : undefined}
          onCreated={(requestId) => {
            setShowForm(false);
            setOpenRequest(requestId);
            void refresh();
          }}
        />
      ) : (
        <Inline>
          <Button appearance="subtle" onClick={() => setShowForm(true)}>
            New request with Accord
          </Button>
        </Inline>
      )}
      <ModalTransition>
        {openRequest ? (
          <DealSheetModal
            requestId={openRequest}
            onChanged={() => void refresh()}
            onClose={() => {
              setOpenRequest(null);
              void refresh();
            }}
          />
        ) : null}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
