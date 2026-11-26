import { useState } from 'react';
import { Footer } from './components/Footer';
import { Sidebar } from './components/Sidebar';
import { TitleBar, type View } from './components/TitleBar';
import { useAppState } from './hooks/useAppState';
import { useNow } from './hooks/useNow';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { StartPage } from './pages/StartPage';
import './components/layout.css';

/** Oberfläche des Launchers: Titelleiste, Hauptbereich + Seitenleiste, Fußzeile. */
export function App() {
  const state = useAppState();
  const now = useNow();
  const [view, setView] = useState<View>('start');
  const loggingIn = state?.phase === 'anmelden';

  return (
    <div className="shell">
      <TitleBar view={view} showTabs={!loggingIn} onNavigate={setView} />
      <div className="shell__body">
        <div className="shell__main">
          {loggingIn ? (
            <LoginPage />
          ) : view === 'start' ? (
            <StartPage state={state} />
          ) : view === 'verlauf' ? (
            <HistoryPage state={state} now={now} />
          ) : (
            <SettingsPage />
          )}
        </div>
        {!loggingIn && <Sidebar state={state} now={now} />}
      </div>
      <Footer state={state} now={now} />
    </div>
  );
}
