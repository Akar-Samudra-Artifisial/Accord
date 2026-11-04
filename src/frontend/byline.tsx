import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Lozenge, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

type BylineState =
  | { ok: true; isCharter: boolean; teamName: string | null; valid: boolean; missing: string[] }
  | { ok: false; error: string };

const App = () => {
  const [state, setState] = useState<BylineState | null>(null);

  useEffect(() => {
    invoke<BylineState>('getBylineState')
      .then((response) => setState('body' in response ? response.body : response))
      .catch((error: unknown) =>
        setState({ ok: false, error: error instanceof Error ? error.message : 'Could not check this page' }),
      );
  }, []);

  if (!state) return <Spinner label="Checking charter" />;
  if (!state.ok) {
    return (
      <SectionMessage appearance="error">
        <Text>{state.error}</Text>
      </SectionMessage>
    );
  }
  if (!state.isCharter) {
    return <Text>This page is not an Accord charter. Create one from the Teams tab of the Accord page in Jira.</Text>;
  }
  return (
    <Stack space="space.100">
      {state.teamName ? <Text>{`Accord charter of ${state.teamName}`}</Text> : null}
      {state.valid ? (
        <Lozenge appearance="success">Charter valid</Lozenge>
      ) : (
        <Stack space="space.050">
          <Lozenge appearance="removed">Charter incomplete</Lozenge>
          <Text>{`Missing or unreadable: ${state.missing.join(', ')}`}</Text>
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
