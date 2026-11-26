/** Abbildung Server-Modelle → IPC-Ansichten. */
import type { CrewMember, Version, WorldResponse } from '../../shared/api-types';
import type { CrewView, HostView, VersionView } from '../../shared/ipc';

export function toVersionView(v: Version, headId: number | null): VersionView {
  return {
    id: v.id,
    label: v.label,
    playSeconds: v.playSeconds,
    uploadedBy: v.uploadedBy,
    uploadedAt: v.uploadedAt,
    type: v.type,
    isHead: headId !== null && v.id === headId,
    conflictReason: v.conflictReason,
  };
}

export function toCrewView(c: CrewMember, me: string | null): CrewView {
  return {
    name: c.name,
    online: c.online,
    status: c.status,
    lastSeen: c.lastSeen,
    isHost: c.isHost,
    isMe: me !== null && c.name === me,
  };
}

/** Aktiver Host laut Server (abgelaufene Lease zählt nicht). */
export function hostView(world: WorldResponse | null, me: string | null): HostView | null {
  const host = world?.host;
  if (host == null || host.expired) return null;
  return { name: host.name, since: host.since, isMe: me !== null && host.name === me };
}

/** „20:14“ in Ortszeit. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
