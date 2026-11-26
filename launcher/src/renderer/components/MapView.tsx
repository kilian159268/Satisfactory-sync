import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { MapData, VersionView } from '../../shared/ipc';
import { formatInteger, initials, joinList } from '../lib/format';
import {
  ZOOM_LEVELS,
  clusterSize,
  computeViewBox,
  createFrame,
  gridLines,
  nextZoom,
  pickVisibleLabels,
  viewBoxString,
  type MapFrame,
  type Point,
} from '../lib/map-geometry';
import { useElementSize } from '../hooks/useElementSize';
import { Skeleton } from './Skeleton';
import './map.css';

interface MapViewProps {
  /** Aktueller Stand; null → kein Spielstand auf dem Server. */
  head: VersionView | null;
  /** Spiel läuft gerade beim Host → Spielerpositionen sind „gerade hier“. */
  live: boolean;
  /** null → AppState noch nicht geladen. */
  loading: boolean;
}

type Selection = { kind: 'cluster' | 'station' | 'player'; id: string } | null;

interface Marker {
  kind: 'cluster' | 'station' | 'player';
  id: string;
  label: string;
  title: string;
  info: string;
  at: Point;
  size: number;
  initials: string;
}

type Loaded =
  | { forId: number; status: 'ok'; data: MapData }
  | { forId: number; status: 'empty' }
  | { forId: number; status: 'error' };

function buildMarkers(data: MapData, frame: MapFrame, live: boolean, label: string): Marker[] {
  const markers: Marker[] = [];
  for (const cluster of data.clusters) {
    const count = formatInteger(cluster.count);
    const title = cluster.count === 1 ? '1 Gebäude' : `${count} Gebäude`;
    markers.push({
      kind: 'cluster',
      id: cluster.id,
      label: title,
      title,
      info:
        cluster.topTypes.length > 0
          ? `Vor allem ${joinList(cluster.topTypes.slice(0, 3))}.`
          : 'Keine Gebäudetypen bekannt.',
      at: frame.project(cluster.x, cluster.y),
      size: clusterSize(cluster.count),
      initials: '',
    });
  }
  data.stations.forEach((station, index) => {
    markers.push({
      kind: 'station',
      id: `s${index}`,
      label: station.name,
      title: station.name,
      info: 'Bahnhof.',
      at: frame.project(station.x, station.y),
      size: 12,
      initials: '',
    });
  });
  data.players.forEach((player, index) => {
    markers.push({
      kind: 'player',
      id: `p${index}`,
      label: player.name,
      title: player.name,
      info: live ? 'Gerade hier unterwegs.' : `Letzte Position in Version ${label}.`,
      at: frame.project(player.x, player.y),
      size: 22,
      initials: initials(player.name),
    });
  });
  return markers;
}

function onActivate(handler: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  };
}

function MapMarker({
  marker,
  selected,
  scale,
  showLabel,
  onSelect,
}: {
  marker: Marker;
  selected: boolean;
  scale: number;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const half = marker.size / 2;
  const cls = `mk mk--${marker.kind}${selected ? ' mk--selected' : ''}`;
  const transform = `translate(${marker.at.x.toFixed(2)} ${marker.at.y.toFixed(2)}) scale(${scale.toFixed(4)})`;
  return (
    <g
      className={cls}
      transform={transform}
      role="button"
      tabIndex={0}
      aria-label={marker.kind === 'station' ? `Bahnhof ${marker.label}` : marker.label}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={onActivate(onSelect)}
    >
      {marker.kind === 'player' ? (
        <>
          <circle className="mk__shape" r={11} strokeWidth={2} />
          <text className="mk__initials" y={4} textAnchor="middle">
            {marker.initials}
          </text>
        </>
      ) : (
        <>
          {marker.kind === 'cluster' ? (
            <rect
              className="mk__shape"
              x={-half}
              y={-half}
              width={marker.size}
              height={marker.size}
              rx={3}
              strokeWidth={2}
            />
          ) : (
            <rect
              className="mk__shape"
              x={-half}
              y={-half}
              width={marker.size}
              height={marker.size}
              rx={2}
              strokeWidth={2}
              transform="rotate(45)"
            />
          )}
          {showLabel && (
            <text
              className="mk__label"
              y={marker.kind === 'station' ? -half - 8 : half + 18}
              textAnchor="middle"
            >
              {marker.label}
            </text>
          )}
        </>
      )}
    </g>
  );
}

/** Karte der Fabrik (selbst gezeichnet, SVG) mit Filter, Zoom und Auswahl. */
export function MapView({ head, live, loading }: MapViewProps) {
  const headId = head?.id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showPlayers, setShowPlayers] = useState(true);
  const [zoom, setZoom] = useState<number>(ZOOM_LEVELS[0]);
  const [selection, setSelection] = useState<Selection>(null);
  const [svgRef, svgSize] = useElementSize();

  useEffect(() => {
    if (headId === null) return;
    let active = true;
    window.schichtwechsel.getMap(headId).then(
      (data) => {
        if (!active) return;
        setLoaded(
          data === null
            ? { forId: headId, status: 'empty' }
            : { forId: headId, status: 'ok', data },
        );
      },
      () => {
        if (active) setLoaded({ forId: headId, status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [headId]);

  const current = loaded !== null && loaded.forId === headId ? loaded : null;
  const data = current?.status === 'ok' ? current.data : null;
  const frame = useMemo(() => (data === null ? null : createFrame(data.bounds)), [data]);
  const label = head?.label ?? '';
  const markers = useMemo(
    () => (data === null || frame === null ? [] : buildMarkers(data, frame, live, label)),
    [data, frame, live, label],
  );
  const grid = useMemo(() => (frame === null ? [] : gridLines(frame)), [frame]);

  const visible = markers.filter((m) => (m.kind === 'player' ? showPlayers : showBuildings));
  const selected =
    selection === null
      ? null
      : (visible.find((m) => m.kind === selection.kind && m.id === selection.id) ?? null);

  if (loading || (headId !== null && current === null)) {
    return (
      <section className="map map--state" aria-label="Karte" aria-busy="true">
        <div className="map__placeholder">
          <Skeleton width={200} />
          <Skeleton width={120} small />
        </div>
      </section>
    );
  }

  if (head === null || frame === null || current === null || data === null) {
    const text =
      head === null
        ? 'Noch kein Spielstand auf dem Server.'
        : current?.status === 'error'
          ? 'Karte konnte nicht geladen werden.'
          : 'Für diesen Stand gibt es noch keine Karte.';
    const hint =
      head === null
        ? 'Die Karte erscheint nach dem ersten Upload.'
        : 'Sie entsteht nach dem nächsten Upload des Hosts.';
    return (
      <section className="map map--state" aria-label="Karte">
        <div className="map__placeholder">
          <p className="map__empty-title">{text}</p>
          <p className="map__empty-hint">{hint}</p>
        </div>
      </section>
    );
  }

  const box = computeViewBox(frame, zoom, zoom > 1 && selected !== null ? selected.at : null);
  const extent = Math.max(frame.width, frame.height) * 3;
  // Marker und Beschriftungen in Bildschirmpixeln: unabhängig von Zoom und Fenstergröße.
  const pxPerUnit =
    svgSize === null
      ? FALLBACK_WIDTH_PX / box.width
      : Math.min(svgSize.width / box.width, svgSize.height / box.height);
  const markerScale = 1 / pxPerUnit;
  const ordered = [...visible].sort((a, b) => order(a) - order(b));
  const keyOf = (m: Marker) => `${m.kind}-${m.id}`;
  const labelled = pickVisibleLabels(
    visible.map((m) => ({ key: keyOf(m), kind: m.kind, at: m.at, size: m.size, label: m.label })),
    markerScale,
    selected === null ? null : keyOf(selected),
  );

  return (
    <section className="map" aria-label="Karte">
      <svg
        ref={svgRef}
        className="map__svg"
        viewBox={viewBoxString(box)}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Karte der Fabrik"
      >
        <rect
          className="map__ground"
          x={-extent}
          y={-extent}
          width={extent * 2 + frame.width}
          height={extent * 2 + frame.height}
        />
        <g className="map__grid" aria-hidden="true">
          {grid.map((line) => (
            <line key={line.key} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
          ))}
        </g>
        {ordered.map((marker) => (
          <MapMarker
            key={`${marker.kind}-${marker.id}`}
            marker={marker}
            selected={selected === marker}
            scale={markerScale}
            showLabel={labelled.has(keyOf(marker))}
            onSelect={() => {
              setSelection({ kind: marker.kind, id: marker.id });
            }}
          />
        ))}
      </svg>

      <div className="map__filters">
        <button
          type="button"
          className="map__filter"
          aria-pressed={showBuildings}
          onClick={() => {
            setShowBuildings((v) => !v);
          }}
        >
          Gebäude
        </button>
        <button
          type="button"
          className="map__filter"
          aria-pressed={showPlayers}
          onClick={() => {
            setShowPlayers((v) => !v);
          }}
        >
          Spieler
        </button>
      </div>

      <div className="map__zoom">
        <button
          type="button"
          className="map__zoom-btn"
          aria-label="Hineinzoomen"
          title={zoom >= maxZoom ? 'Größte Zoomstufe erreicht' : 'Hineinzoomen'}
          disabled={zoom >= maxZoom}
          onClick={() => {
            setZoom((z) => nextZoom(z, 1));
          }}
        >
          +
        </button>
        <button
          type="button"
          className="map__zoom-btn"
          aria-label="Herauszoomen"
          title={zoom <= minZoom ? 'Kleinste Zoomstufe erreicht' : 'Herauszoomen'}
          disabled={zoom <= minZoom}
          onClick={() => {
            setZoom((z) => nextZoom(z, -1));
          }}
        >
          −
        </button>
      </div>

      {selected !== null && (
        <div className="map__info" role="region" aria-label="Auswahl">
          <div className="map__info-head">
            <span className="map__info-title">{selected.title}</span>
            <button
              type="button"
              className="map__info-close"
              aria-label="Info schließen"
              onClick={() => {
                setSelection(null);
              }}
            >
              ×
            </button>
          </div>
          <p className="map__info-text">{selected.info}</p>
        </div>
      )}

      <p className="map__version">Aus Version {head.label}</p>
    </section>
  );
}

const minZoom = ZOOM_LEVELS[0];
/** Annahme für die Pixelbreite, solange die Karte noch nicht gemessen ist. */
const FALLBACK_WIDTH_PX = 680;
const maxZoom = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? minZoom;

/** Zeichenreihenfolge: Gebäude unten, Bahnhöfe darüber, Spieler oben. */
function order(marker: Marker): number {
  return marker.kind === 'cluster' ? 0 : marker.kind === 'station' ? 1 : 2;
}
