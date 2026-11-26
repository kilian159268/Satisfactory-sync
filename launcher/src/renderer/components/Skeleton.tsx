export type SkeletonWidth = 40 | 80 | 120 | 160 | 180 | 200 | 'full';

/** Platzhalterbalken während des Ladens; für Screenreader unsichtbar. */
export function Skeleton({ width, small = false }: { width: SkeletonWidth; small?: boolean }) {
  const classes = ['skel', `skel-w-${String(width)}`];
  if (small) classes.push('skel--small');
  return <span className={classes.join(' ')} aria-hidden="true" />;
}
