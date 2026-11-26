/** Synthetische Satisfactory-Saves (nur der Header + etwas Füllung). */
export interface SaveSpec {
  headerVersion?: number;
  saveVersion?: number;
  buildVersion?: number;
  saveName?: string;
  mapName?: string;
  mapOptions?: string;
  sessionName: string;
  playSeconds: number;
  saveTicks?: bigint;
  /** Strings als UTF-16 (negative Länge) kodieren. */
  utf16?: boolean;
  /** Bytes nach dem Header (simulierter Körper); macht Saves mit gleichem Header unterscheidbar. */
  body?: string;
}

function fstring(value: string, utf16: boolean): Uint8Array {
  if (value === '') return new Uint8Array(4);
  if (utf16) {
    const chars = value.length + 1;
    const out = new Uint8Array(4 + chars * 2);
    const view = new DataView(out.buffer);
    view.setInt32(0, -chars, true);
    for (let i = 0; i < value.length; i++) view.setUint16(4 + i * 2, value.charCodeAt(i), true);
    return out;
  }
  const out = new Uint8Array(4 + value.length + 1);
  new DataView(out.buffer).setInt32(0, value.length + 1, true);
  for (let i = 0; i < value.length; i++) out[4 + i] = value.charCodeAt(i) & 0xff;
  return out;
}

export function buildSave(spec: SaveSpec): Uint8Array {
  const hv = spec.headerVersion ?? 14;
  const utf16 = spec.utf16 ?? false;
  const parts: Uint8Array[] = [];
  const ints = new Uint8Array(12);
  const v = new DataView(ints.buffer);
  v.setInt32(0, hv, true);
  v.setInt32(4, spec.saveVersion ?? 46, true);
  v.setInt32(8, spec.buildVersion ?? 400000, true);
  parts.push(ints);
  if (hv >= 14) parts.push(fstring(spec.saveName ?? spec.sessionName, utf16));
  parts.push(fstring(spec.mapName ?? 'Persistent_Level', utf16));
  parts.push(fstring(spec.mapOptions ?? '?startloc=Grass Fields', utf16));
  parts.push(fstring(spec.sessionName, utf16));
  const tail = new Uint8Array(12);
  const tv = new DataView(tail.buffer);
  tv.setInt32(0, spec.playSeconds, true);
  tv.setBigInt64(4, spec.saveTicks ?? 639000000000000000n, true);
  parts.push(tail);
  parts.push(new TextEncoder().encode(spec.body ?? 'KÖRPER'.repeat(50)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
