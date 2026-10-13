/**
 * FinOps dashboard (token observability) — the full spend surface.
 *
 * Mounted as a right-hand sheet (mirrors AdminPanel), self-contained under
 * `.admin-root` so its Tailwind/shadcn styling never touches the hand-styled
 * beats. Shows:
 *   - headline session total (tokens + cost) and a budget progress bar with
 *     warn/over states,
 *   - per-surface and per-model breakdown (table + a recharts bar + pie),
 *   - a historical area chart of cumulative spend from the ledger,
 *   - an EDITABLE price-table + budget form that writes back through the admin
 *     config (adminApi.put({ finops })) — the same hot-apply path as the prompts.
 *
 * OBSERVABILITY ONLY: nothing here changes what the LLM is allowed to answer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  CartesianGrid,
  Legend,
} from "recharts";
import { Activity, Loader2, RotateCcw, Save, Plus, Trash2 } from "lucide-react";
import {
  finopsApi,
  adminApi,
  type FinOpsSummary,
  type FinOpsEntry,
  type FinOpsConfig,
  type FinOpsModelPrice,
} from "../api.js";
import { fmtUsd, fmtTokens } from "./useFinops.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

// Brand-aligned palette for the charts (kept legible on the dashboard cards).
const SURFACE_COLORS = ["#1769d6", "#13b8a6", "#bc8cff", "#f78166", "#e0a93b", "#79c0ff"];

/** Friendly capability names for the raw FinOps surface ids (the "capability"
 *  attribution the dashboard reports). Unknown ids pass through unchanged. */
const CAP_LABELS: Record<string, string> = {
  ask: "Ask the graph",
  narrate: "Narrator",
  runtime: "Conversation",
  "explain-node": "Explain node",
  resolve: "Resolve",
};
const capLabel = (key: string) => CAP_LABELS[key] ?? key;

/** Build cumulative-spend points (oldest→newest) for the historical area chart. */
function cumulativeSeries(entries: FinOpsEntry[]) {
  const asc = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  let acc = 0;
  return asc.map((e, i) => {
    acc += e.costUsd;
    return {
      i: i + 1,
      label: new Date(e.ts).toLocaleTimeString(),
      cumCost: Math.round(acc * 1e6) / 1e6,
      cost: e.costUsd,
      surface: e.surface,
    };
  });
}

export function FinOpsDashboard({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  const [summary, setSummary] = useState<FinOpsSummary | null>(null);
  const [entries, setEntries] = useState<FinOpsEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable price/budget form (writes via adminApi.put({ finops })).
  const [finops, setFinops] = useState<FinOpsConfig | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const [s, l] = await Promise.all([finopsApi.summary(), finopsApi.ledger(200)]);
      setSummary(s);
      setEntries(l);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  async function loadConfig() {
    try {
      const res = await adminApi.get();
      setFinops(res.config.finops);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    void loadConfig();
    const t = window.setInterval(refresh, 4000); // live feel
    return () => window.clearInterval(t);
  }, []);

  const series = useMemo(() => cumulativeSeries(entries), [entries]);

  async function saveConfig() {
    if (!finops) return;
    setSaving(true);
    const result = await adminApi.put({ finops });
    setSaving(false);
    if (result.ok) {
      setFinops(result.data.config.finops);
      toast.success("FinOps prices & budget saved — hot-applied", {
        description: "New cost is applied on the next /finops/summary poll.",
      });
      void refresh();
    } else {
      toast.error(`Save rejected (${result.status})`, {
        description: result.issues.length
          ? `${result.issues.length} field(s) failed validation.`
          : result.error,
      });
    }
  }

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="FinOps dashboard"
        className="flex h-full w-full max-w-3xl flex-col bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Activity className="size-5 text-primary" />
              FinOps — token spend
            </div>
            <p className="text-xs text-muted-foreground">
              Live LLM token usage &amp; cost. Observability only — it never changes what the
              model may answer.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close FinOps dashboard">
            Close
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loadError && !summary && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading FinOps data…
            </div>
          )}

          {summary && (
            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="prices">Prices &amp; budget</TabsTrigger>
              </TabsList>

              {/* ---------- OVERVIEW ---------- */}
              <TabsContent value="overview" className="space-y-5">
                <Headline summary={summary} />

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
                  <BudgetGauge summary={summary} />
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Cost by capability</CardTitle>
                      <CardDescription>Which capability the spend comes from</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div style={{ height: 210 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={summary.bySurface} margin={{ left: -10 }}>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="key" fontSize={11} tickFormatter={capLabel} interval={0} />
                            <YAxis fontSize={11} />
                            <Tooltip
                              formatter={(v) => fmtUsd(Number(v))}
                              labelFormatter={(l) => capLabel(String(l))}
                            />
                            <Bar dataKey="costUsd" name="Cost (USD)" radius={[4, 4, 0, 0]}>
                              {summary.bySurface.map((_, i) => (
                                <Cell key={i} fill={SURFACE_COLORS[i % SURFACE_COLORS.length]} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Cost share by capability</CardTitle>
                      <CardDescription>Proportion of session USD</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div style={{ height: 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={summary.bySurface}
                              dataKey="costUsd"
                              nameKey="key"
                              cx="50%"
                              cy="50%"
                              innerRadius={42}
                              outerRadius={75}
                              paddingAngle={2}
                              isAnimationActive={false}
                            >
                              {summary.bySurface.map((_, i) => (
                                <Cell key={i} fill={SURFACE_COLORS[i % SURFACE_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(v) => fmtUsd(Number(v))} />
                            <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => capLabel(String(v))} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Tokens by model</CardTitle>
                      <CardDescription>Total tokens per model</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div style={{ height: 220 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={summary.byModel}
                              dataKey="totalTokens"
                              nameKey="key"
                              cx="50%"
                              cy="50%"
                              outerRadius={75}
                              isAnimationActive={false}
                              label={(e: { value?: number }) => fmtTokens(Number(e.value ?? 0))}
                            >
                              {summary.byModel.map((_, i) => (
                                <Cell key={i} fill={SURFACE_COLORS[i % SURFACE_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(v) => `${fmtTokens(Number(v))} tok`} />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <BreakdownTable title="Per-capability" rows={summary.bySurface} labelize={capLabel} />
                <BreakdownTable title="Per-model" rows={summary.byModel} />
              </TabsContent>

              {/* ---------- HISTORY ---------- */}
              <TabsContent value="history" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Cumulative spend over time</CardTitle>
                    <CardDescription>
                      Running USD across {entries.length} recorded LLM call(s)
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div style={{ height: 280 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={series} margin={{ left: -10 }}>
                          <defs>
                            <linearGradient id="finopsFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#1769d6" stopOpacity={0.5} />
                              <stop offset="100%" stopColor="#1769d6" stopOpacity={0.05} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                          <XAxis dataKey="label" fontSize={10} minTickGap={24} />
                          <YAxis fontSize={11} />
                          <Tooltip formatter={(v) => fmtUsd(Number(v))} />
                          <Area
                            type="monotone"
                            dataKey="cumCost"
                            name="Cumulative (USD)"
                            stroke="#1769d6"
                            fill="url(#finopsFill)"
                            strokeWidth={2}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                    {entries.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No LLM calls recorded yet — run a narration or ask the graph a question to
                        populate the ledger.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <LedgerTable entries={entries.slice(0, 20)} />
              </TabsContent>

              {/* ---------- PRICES & BUDGET (editable) ---------- */}
              <TabsContent value="prices" className="space-y-4">
                {finops ? (
                  <PriceEditor
                    finops={finops}
                    onChange={setFinops}
                    onSave={saveConfig}
                    onReset={loadConfig}
                    saving={saving}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading price table…
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}

function Headline({ summary }: { summary: FinOpsSummary }) {
  const stat = (label: string, value: string, hint?: string) => (
    <Card>
      <CardContent className="pt-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stat("Session cost", fmtUsd(summary.totalCostUsd))}
      {stat("Total tokens", fmtTokens(summary.totalTokens), `${summary.totalInputTokens} in · ${summary.totalOutputTokens} out`)}
      {stat("LLM calls", String(summary.entryCount))}
      {stat("Budget used", `${summary.budget.pctUsed.toFixed(0)}%`, `of ${fmtUsd(summary.budget.budgetUsd)}`)}
    </div>
  );
}

/** Radial budget gauge — a 270° SVG dial of budget consumed, with warn/over
 *  colouring. Replaces the old flat bar; reads clearer at a glance for execs. */
function BudgetGauge({ summary }: { summary: FinOpsSummary }) {
  const { pctUsed, overThreshold, overBudget, warnThresholdPct } = summary.budget;
  const color = overBudget ? "#de4a3b" : overThreshold ? "#e0a93b" : "#2bb673";
  const state = overBudget ? "OVER BUDGET" : overThreshold ? "WARN" : "OK";

  // 270° sweep (gap at the bottom). Geometry for a 120×120 viewBox dial.
  const size = 130;
  const cx = size / 2;
  const cy = size / 2;
  const r = 52;
  const startAngle = 135; // degrees (SVG, 0°=east, clockwise positive here)
  const sweep = 270;
  const frac = Math.max(0, Math.min(1, pctUsed / 100));
  const warnFrac = Math.max(0, Math.min(1, warnThresholdPct / 100));

  const polar = (angleDeg: number) => {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const arcPath = (fromFrac: number, toFrac: number) => {
    const a0 = startAngle + sweep * fromFrac;
    const a1 = startAngle + sweep * toFrac;
    const [x0, y0] = polar(a0);
    const [x1, y1] = polar(a1);
    const large = sweep * (toFrac - fromFrac) > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  // Warn tick position on the track.
  const [wx, wy] = polar(startAngle + sweep * warnFrac);

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Budget</span>
          <Badge
            variant={overBudget ? "destructive" : overThreshold ? "secondary" : "default"}
            className="gap-1"
          >
            {state}
          </Badge>
        </CardTitle>
        <CardDescription>
          warn at {warnThresholdPct}% of {fmtUsd(summary.budget.budgetUsd)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center">
        <div style={{ position: "relative", width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`Budget ${pctUsed.toFixed(0)}% used`} role="img">
            {/* track */}
            <path d={arcPath(0, 1)} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={11} strokeLinecap="round" className="text-muted-foreground" />
            {/* value */}
            {frac > 0 && (
              <path d={arcPath(0, frac)} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" />
            )}
            {/* warn threshold tick */}
            <circle cx={wx} cy={wy} r={2.4} fill="#e0a93b" />
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="text-2xl font-semibold tabular-nums text-foreground">{pctUsed.toFixed(0)}%</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">{fmtUsd(summary.totalCostUsd)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownTable({
  title,
  rows,
  labelize,
}: {
  title: string;
  rows: FinOpsSummary["bySurface"];
  labelize?: (key: string) => string;
}) {
  return (
    <div>
      <Label className="mb-1.5 block">{title}</Label>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{labelize ? "Capability" : "Key"}</th>
              <th className="px-3 py-2 text-right font-medium">Calls</th>
              <th className="px-3 py-2 text-right font-medium">In</th>
              <th className="px-3 py-2 text-right font-medium">Out</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-1.5 font-mono text-xs">{labelize ? labelize(r.key) : r.key}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.count}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.inputTokens}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.outputTokens}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-center text-muted-foreground">
                  No data yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LedgerTable({ entries }: { entries: FinOpsEntry[] }) {
  return (
    <div>
      <Label className="mb-1.5 block">Recent calls (newest first)</Label>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Time</th>
              <th className="px-3 py-2 text-left font-medium">Surface</th>
              <th className="px-3 py-2 text-left font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">In/Out</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="px-3 py-1.5 text-xs">{new Date(e.ts).toLocaleTimeString()}</td>
                <td className="px-3 py-1.5">
                  <Badge variant="outline" className="text-[11px]">
                    {e.surface}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px]">
                  {e.model}
                  {e.estimated && <span className="ml-1 text-amber-600">~est</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-xs">
                  {e.inputTokens}/{e.outputTokens}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtUsd(e.costUsd)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-center text-muted-foreground">
                  No calls recorded yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PriceEditor({
  finops,
  onChange,
  onSave,
  onReset,
  saving,
}: {
  finops: FinOpsConfig;
  onChange: (f: FinOpsConfig) => void;
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
}) {
  const [newModel, setNewModel] = useState("");

  function setPrice(model: string, field: keyof FinOpsModelPrice, raw: string) {
    onChange({
      ...finops,
      prices: {
        ...finops.prices,
        [model]: { ...finops.prices[model], [field]: raw.trim() === "" ? NaN : Number(raw) },
      },
    });
  }
  function removeModel(model: string) {
    const { [model]: _drop, ...rest } = finops.prices;
    onChange({ ...finops, prices: rest });
  }
  function addModel() {
    const id = newModel.trim();
    if (!id || finops.prices[id]) return;
    onChange({ ...finops, prices: { ...finops.prices, [id]: { inputPerMTok: 0, outputPerMTok: 0 } } });
    setNewModel("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Price table &amp; budget</CardTitle>
        <CardDescription>
          USD per 1,000,000 tokens. Edits write through the admin config and hot-apply on the next
          summary poll. Observability only — prices never gate the model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Input / MTok</th>
                <th className="px-3 py-2 text-right font-medium">Output / MTok</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {Object.entries(finops.prices).map(([model, p]) => (
                <tr key={model} className="border-t">
                  <td className="px-3 py-1.5 font-mono text-[11px]">{model}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      type="number"
                      step="0.1"
                      className="ml-auto h-8 w-24 text-right"
                      value={Number.isNaN(p.inputPerMTok) ? "" : p.inputPerMTok}
                      onChange={(e) => setPrice(model, "inputPerMTok", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      type="number"
                      step="0.1"
                      className="ml-auto h-8 w-24 text-right"
                      value={Number.isNaN(p.outputPerMTok) ? "" : p.outputPerMTok}
                      onChange={(e) => setPrice(model, "outputPerMTok", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeModel(model)}
                      aria-label={`Remove ${model}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="newModel" className="text-xs">
              Add a model
            </Label>
            <Input
              id="newModel"
              placeholder="claude-…"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={addModel}>
            <Plus className="size-4" /> Add
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="defIn" className="text-xs">
              Default input / MTok (unlisted models)
            </Label>
            <Input
              id="defIn"
              type="number"
              step="0.1"
              value={Number.isNaN(finops.defaultPrice.inputPerMTok) ? "" : finops.defaultPrice.inputPerMTok}
              onChange={(e) =>
                onChange({
                  ...finops,
                  defaultPrice: {
                    ...finops.defaultPrice,
                    inputPerMTok: e.target.value.trim() === "" ? NaN : Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defOut" className="text-xs">
              Default output / MTok
            </Label>
            <Input
              id="defOut"
              type="number"
              step="0.1"
              value={Number.isNaN(finops.defaultPrice.outputPerMTok) ? "" : finops.defaultPrice.outputPerMTok}
              onChange={(e) =>
                onChange({
                  ...finops,
                  defaultPrice: {
                    ...finops.defaultPrice,
                    outputPerMTok: e.target.value.trim() === "" ? NaN : Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget" className="text-xs">
              Session budget (USD)
            </Label>
            <Input
              id="budget"
              type="number"
              step="0.5"
              value={Number.isNaN(finops.budgetUsd) ? "" : finops.budgetUsd}
              onChange={(e) =>
                onChange({ ...finops, budgetUsd: e.target.value.trim() === "" ? NaN : Number(e.target.value) })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="warn" className="text-xs">
              Warn threshold (% of budget)
            </Label>
            <Input
              id="warn"
              type="number"
              step="1"
              value={Number.isNaN(finops.warnThresholdPct) ? "" : finops.warnThresholdPct}
              onChange={(e) =>
                onChange({
                  ...finops,
                  warnThresholdPct: e.target.value.trim() === "" ? NaN : Number(e.target.value),
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center gap-3 border-t pt-4">
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save prices &amp; budget
          </Button>
          <Button variant="outline" onClick={onReset} disabled={saving}>
            <RotateCcw className="size-4" /> Reset to saved
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
