import type { AppState, CrewView } from '../../shared/ipc';
import { formatDayTime, formatLastSeen, formatPlaytime, initials } from '../lib/format';
import { Skeleton } from './Skeleton';
import './layout.css';

interface SidebarProps {
  state: AppState | null;
  now: Date;
}

function crewStatus(member: CrewView, now: Date): string {
  if (!member.online) return formatLastSeen(member.lastSeen, now);
  if (member.isHost) return 'hostet gerade';
  if (member.status === 'im_spiel') return 'im Spiel';
  return 'Launcher offen';
}

function CurrentVersion({ state, now }: SidebarProps) {
  if (state === null) {
    return (
      <div className="facts" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="facts__skel">
            <Skeleton width={80} small />
            <Skeleton width={80} small />
          </div>
        ))}
      </div>
    );
  }
  const head = state.head;
  if (head === null) {
    return <p className="sidebar__empty">Noch kein Spielstand auf dem Server.</p>;
  }
  const by = state.me !== null && head.uploadedBy === state.me.name ? 'Du' : head.uploadedBy;
  return (
    <dl className="facts">
      <dt>Version</dt>
      <dd>{head.label}</dd>
      <dt>Spielzeit</dt>
      <dd>{formatPlaytime(head.playSeconds)}</dd>
      <dt>Gespeichert</dt>
      <dd>{formatDayTime(head.uploadedAt, now)}</dd>
      <dt>Von</dt>
      <dd>{by}</dd>
    </dl>
  );
}

function Crew({ state, now }: SidebarProps) {
  if (state === null) {
    return (
      <ul className="crew" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="crew__member">
            <span className="crew__avatar crew__avatar--offline" aria-hidden="true" />
            <span className="crew__text">
              <Skeleton width={120} small />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (state.crew.length === 0) {
    return <p className="sidebar__empty">Noch niemand in der Gruppe.</p>;
  }
  return (
    <ul className="crew">
      {state.crew.map((member) => {
        const modifier = member.isHost
          ? 'crew__avatar--host'
          : member.online
            ? 'crew__avatar--online'
            : 'crew__avatar--offline';
        const name = member.isMe ? 'Du' : member.name;
        return (
          <li key={member.name} className="crew__member">
            <span className={`crew__avatar ${modifier}`} aria-hidden="true">
              {member.isMe ? 'Du' : initials(member.name)}
            </span>
            <span className="crew__text">
              <span className={member.online ? 'crew__name' : 'crew__name crew__name--offline'}>
                {name}
              </span>
              <span className="crew__status">{crewStatus(member, now)}</span>
            </span>
            {member.isHost && <span className="host-badge">Host</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Rechte Seitenleiste: „Aktueller Stand“ und „Gruppe“. */
export function Sidebar({ state, now }: SidebarProps) {
  const online = state?.crew.filter((c) => c.online).length ?? 0;
  const total = state?.crew.length ?? 0;
  return (
    <aside className="sidebar" aria-label="Übersicht">
      <section className="sidebar__section" aria-labelledby="sidebar-stand">
        <h2 id="sidebar-stand" className="sidebar__heading">
          Aktueller Stand
        </h2>
        <CurrentVersion state={state} now={now} />
      </section>
      <section className="sidebar__section sidebar__section--crew" aria-labelledby="sidebar-crew">
        <div className="sidebar__heading-row">
          <h2 id="sidebar-crew" className="sidebar__heading">
            Gruppe
          </h2>
          {state !== null && total > 0 && (
            <span className="sidebar__count">
              {online} von {total} online
            </span>
          )}
        </div>
        <Crew state={state} now={now} />
      </section>
    </aside>
  );
}
