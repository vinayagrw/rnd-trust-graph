/**
 * FinOps live meter — a compact header control showing running session cost +
 * token count, now with a live cost-trend SPARKLINE built from the recent ledger.
 * Turns amber at the warn threshold and red over budget. Styled to match the
 * existing header controls (reuses the shadcn Button `control`/`brand` idiom);
 * clicking it opens the full FinOps dashboard.
 *
 * Observability only — this meter reads recorded usage and changes nothing about
 * what the LLM may answer.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { finopsApi, type FinOpsEntry } from "../api.js";
import { useFinops, fmtUsd, fmtTokens } from "./useFinops.js";
import { Sparkline } from "./Sparkline.js";

export function FinOpsMeter({ onOpen }: { onOpen: () => void }) {
  const { summary } = useFinops(4000, true);

  // Recent ledger tail → cumulative-cost series for the sparkline. Polled on the
  // same cadence as the summary; a failed poll keeps the last good series so the
  // meter never blanks mid-demo.
  const [recent, setRecent] = useState<FinOpsEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = () =>
      finopsApi
        .ledger(24)
        .then((e) => alive && setRecent(e))
        .catch(() => {});
    pull();
    const t = window.setInterval(pull, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const spark = useMemo(() => {
    // ledger() returns newest-first → reverse to oldest-first, accumulate cost.
    const asc = [...recent].reverse();
    let acc = 0;
    return asc.map((e) => (acc += e.costUsd));
  }, [recent]);

  const cost = summary?.totalCostUsd ?? 0;
  const tokens = summary?.totalTokens ?? 0;
  const over = summary?.budget.overBudget ?? false;
  const warn = summary?.budget.overThreshold ?? false;

  // Status colour: red over budget, amber over warn threshold, else neutral.
  // Applied as an inline accent so it works on either skin without new CSS.
  const accent = over ? "#de4a3b" : warn ? "#e0a93b" : undefined;
  const dot = over ? "#de4a3b" : warn ? "#e0a93b" : "#3fb950";
  const sparkColor = over ? "#de4a3b" : warn ? "#e0a93b" : "#13b8a6";

  const title = over
    ? `Over budget — ${fmtUsd(cost)} of ${fmtUsd(summary?.budget.budgetUsd ?? 0)} (${summary?.budget.pctUsed.toFixed(0)}%)`
    : warn
      ? `Approaching budget — ${summary?.budget.pctUsed.toFixed(0)}% of ${fmtUsd(summary?.budget.budgetUsd ?? 0)}`
      : `LLM token spend this session — click for the FinOps dashboard`;

  return (
    <Button
      variant="control"
      size="brand"
      onClick={onOpen}
      title={title}
      aria-label="Open FinOps dashboard"
      style={accent ? { borderColor: accent, color: accent } : undefined}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot,
          display: "inline-block",
          marginRight: 2,
        }}
      />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtUsd(cost)}</span>
      <span style={{ opacity: 0.6, margin: "0 2px" }}>·</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtTokens(tokens)} tok</span>
      {spark.length >= 2 && (
        <span style={{ display: "inline-flex", alignItems: "center", marginLeft: 4 }}>
          <Sparkline points={spark} stroke={sparkColor} title="Recent cost trend" />
        </span>
      )}
    </Button>
  );
}
