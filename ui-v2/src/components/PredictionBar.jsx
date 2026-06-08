import { resolvePredictionColors, segmentCssVars } from "../lib/teamColors";

export default function PredictionBar({ data, fx, heightClass = "h-1", className = "" }) {
  const p = fx?.probabilities || {};
  const colors = resolvePredictionColors(fx?.home, fx?.away, data?.__teamColors || {});

  return (
    <div
      className={`prediction-glass-bar ${heightClass} ${className}`}
      data-clash-adjusted={colors.clash_adjusted ? "true" : "false"}
      aria-hidden="true"
    >
      <Segment value={p.home_win} segment={colors.home} />
      <Segment value={p.draw} segment={colors.draw} />
      <Segment value={p.away_win} segment={colors.away} />
    </div>
  );
}

function Segment({ value, segment }) {
  const grow = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  return (
    <span
      className={`prediction-glass-segment ${segment.light ? "prediction-glass-segment--light" : ""}`}
      data-color-source={segment.source}
      style={{ flexGrow: grow, flexBasis: 0, ...segmentCssVars(segment.color) }}
    />
  );
}
