/**
 * Eval scorecard (F2) — RAGAS-style answer-quality observability.
 *
 * Mounted as a right-hand sheet (mirrors FinOpsDashboard / AdminPanel), self-
 * contained under `.admin-root` so its Tailwind/shadcn styling never touches the
 * hand-styled beats. Shows the rolling answer-quality averages — faithfulness
 * (F1), context-recall (deterministic), and answer-relevancy (LLM judge; shown as
 * "—" when the judge is off) — plus a per-answer recent list.
 *
 * OBSERVABILITY ONLY: nothing here changes what the LLM is allowed to answer; it
 * only MEASURES the quality of grounded answers after the fact.
 */
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { AlertCircle, Gauge, Loader2 } from "lucide-react";
import { evalApi, type EvalSummary } from "../api.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** A 0..1 score as a whole percent, or "—" for a null (judge-off) metric. */
function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

/** Band colour for a 0..1 score (matches the chat faithfulness badge). */
function bandColor(n: number | null): string {
  if (n === null) return "var(--muted-foreground, #888)";
  if (n >= 0.8) return "#2bb673";
  if (n >= 0.5) return "#e0a93b";
  return "#de4a3b";
}

function MetricCard({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-3xl font-semibold tabular-nums" style={{ color: bandColor(value) }}>
          {pct(value)}
        </div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

export function EvalScorecard({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      evalApi
        .summary(50)
        .then((s) => {
          if (alive) {
            setSummary(s);
            setLoadError(null);
          }
        })
        .catch((e) => {
          if (alive) setLoadError(String(e));
        });
    void refresh();
    const t = window.setInterval(refresh, 4000); // live feel
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Answer-quality scorecard"
        className="flex h-full w-full max-w-2xl flex-col bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Gauge className="size-5 text-primary" />
              Answer quality — eval scorecard
            </div>
            <p className="text-xs text-muted-foreground">
              RAGAS-style per-answer metrics. Observability only — it never changes what the model
              may answer.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close eval scorecard">
            Close
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {!summary && !loadError && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading eval data…
            </div>
          )}

          {!summary && loadError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-4" /> Couldn't load eval data — {loadError}
            </div>
          )}

          {summary && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Faithfulness"
                  value={summary.avgFaithfulness}
                  hint="answer claims traceable to cited evidence"
                />
                <MetricCard
                  label="Context recall"
                  value={summary.avgContextRecall}
                  hint="question entities found in retrieved evidence"
                />
                <MetricCard
                  label="Answer relevancy"
                  value={summary.avgAnswerRelevancy}
                  hint={
                    summary.avgAnswerRelevancy === null
                      ? "LLM judge off (deterministic metrics only)"
                      : "answer addresses the question (judged)"
                  }
                />
              </div>

              <div className="text-xs text-muted-foreground">
                Averaged over <strong>{summary.entryCount}</strong> grounded answer(s). Refusals and
                fallbacks are not scored. Faithfulness and context-recall are deterministic; answer
                relevancy uses the optional LLM judge (off by default).
              </div>

              <RecentTable summary={summary} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentTable({ summary }: { summary: EvalSummary }) {
  return (
    <div>
      <Label className="mb-1.5 block">Recent answers (newest first)</Label>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Time</th>
              <th className="px-3 py-2 text-left font-medium">Question</th>
              <th className="px-3 py-2 text-right font-medium">Faith</th>
              <th className="px-3 py-2 text-right font-medium">Recall</th>
              <th className="px-3 py-2 text-right font-medium">Relev</th>
              <th className="px-3 py-2 text-right font-medium">Cited</th>
            </tr>
          </thead>
          <tbody>
            {summary.recent.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="px-3 py-1.5 text-xs">{new Date(e.ts).toLocaleTimeString()}</td>
                <td className="px-3 py-1.5 text-xs">
                  <span className="line-clamp-1" title={e.question}>
                    {e.question || "—"}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: bandColor(e.faithfulness) }}>
                  {pct(e.faithfulness)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: bandColor(e.contextRecall) }}>
                  {pct(e.contextRecall)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {pct(e.answerRelevancy)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  <Badge variant="outline" className="text-[11px]">
                    {e.citedCount}
                  </Badge>
                </td>
              </tr>
            ))}
            {summary.recent.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-muted-foreground">
                  No grounded answers scored yet — ask the graph a question to populate the scorecard.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
