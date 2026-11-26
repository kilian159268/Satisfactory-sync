import { Logo } from './Logo';
import './layout.css';

export type View = 'start' | 'verlauf' | 'einstellungen';

const TABS: { id: View; label: string }[] = [
  { id: 'start', label: 'Start' },
  { id: 'verlauf', label: 'Verlauf' },
  { id: 'einstellungen', label: 'Einstellungen' },
];

interface TitleBarProps {
  view: View;
  /** false → keine Reiter (z. B. beim Anmelden). */
  showTabs: boolean;
  onNavigate: (view: View) => void;
}

/** Eigene Titelleiste (rahmenloses Fenster): ziehbar, Knöpfe ausgenommen. */
export function TitleBar({ view, showTabs, onNavigate }: TitleBarProps) {
  const api = window.schichtwechsel;
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <Logo />
        <span className="titlebar__name">V3in-sync</span>
      </div>
      {showTabs && (
        <nav className="titlebar__tabs" aria-label="Bereiche">
          {TABS.map((tab) => {
            const current = tab.id === view;
            return (
              <button
                key={tab.id}
                type="button"
                className={current ? 'tab tab--current' : 'tab'}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  onNavigate(tab.id);
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}
      <div className="titlebar__window">
        <button
          type="button"
          className="titlebar__control"
          aria-label="Minimieren"
          title="Minimieren"
          onClick={() => {
            api.window.minimize();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__control titlebar__control--close"
          aria-label="Schließen"
          title="Schließen"
          onClick={() => {
            api.window.close();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </header>
  );
}
