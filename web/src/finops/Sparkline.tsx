/**
 * Sparkline — a tiny, dependency-free SVG line+area for the header FinOps meter.
 * Pure geometry (no recharts) so it's cheap enough to live in the always-on chip.
 * Draws a cumulative-cost trend; a flat/empty series degrades to a baseline line.
 */
interface Props {
  /** Cumulative values, oldest→newest. */
  points: number[];
  width?: number;
  height?: number;
  stroke?: string;
  /** Accessible label; the SVG is otherwise aria-hidden decoration. */
  title?: string;
}

export function Sparkline({
  points,
  width = 54,
  height = 16,
  stroke = "#13b8a6",
  title,
}: Props) {
  const pad = 1.5;
  const w = width - pad * 2;
  const h = height - pad * 2;

  // Need ≥2 points to draw a trend; otherwise show a flat baseline.
  const series = points.length >= 2 ? points : [0, 0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = w / (series.length - 1);

  const xy = series.map((v, i) => {
    const x = pad + i * stepX;
    // Invert Y (SVG origin top-left); keep a hair of headroom.
    const y = pad + h - ((v - min) / span) * h;
    return [x, y] as const;
  });

  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${(pad + w).toFixed(1)},${(pad + h).toFixed(1)} L${pad.toFixed(1)},${(pad + h).toFixed(1)} Z`;
  const last = xy[xy.length - 1];
  const gradId = `spark-${stroke.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.30} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={1.7} fill={stroke} />}
    </svg>
  );
}
