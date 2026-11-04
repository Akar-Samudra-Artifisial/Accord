import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Heading, Lozenge, SectionMessage, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

interface PanelState {
  status: string;
}

const App = () => {
  const [state, setState] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PanelState>('getPanelState')
      .then((response) => setState('body' in response ? response.body : response))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load Accord status'));
  }, []);

  return (
    <Stack space="space.100">
      <Heading size="small">Accord</Heading>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : (
        <Text>
          Dependency status: <Lozenge>{state ? state.status : 'loading'}</Lozenge>
        </Text>
      )}
      <Text>Request form and deal sheet are coming in the next milestone.</Text>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
