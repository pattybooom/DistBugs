import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import SpatialLab from './src/lab/SpatialLab';
import { EcosystemScreen } from './src/ui/EcosystemScreen';
import { useEcosystem } from './src/ui/useEcosystem';

type Screen = 'ecosystem' | 'lab';

export default function App() {
  const [screen, setScreen] = useState<Screen>('ecosystem');
  // The ecosystem lives here so it survives a visit to the lab; it only runs while it is on screen.
  const ecosystem = useEcosystem(screen === 'ecosystem');

  return (
    <>
      <StatusBar style="light" />
      {screen === 'lab'
        ? <SpatialLab onExit={() => setScreen('ecosystem')} />
        : <EcosystemScreen ecosystem={ecosystem} onOpenLab={() => setScreen('lab')} />}
    </>
  );
}
