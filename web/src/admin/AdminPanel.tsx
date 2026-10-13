/**
 * Admin panel (Phase 3b) — the in-UI prompt / guardrail control surface.
 *
 * Built on shadcn/ui (Tailwind v4). Entirely self-contained under `.admin-root`
 * so its Tailwind styles never touch the existing hand-styled beats. Consumes
 * the Phase-3a config API (GET/PUT /api/admin/config) — it does not change any
 * BFF logic.
 *
 * Trust story made visible: the EDITABLE block lets a presenter tune prompts +
 * thresholds + the refusal marker live; the ENFORCED block is rendered LOCKED
 * with no control that can edit it — "you can tune prompts, but you cannot
 * switch off grounding."
 */
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Lock, ShieldCheck, RotateCcw, Save, Loader2 } from "lucide-react";
import {
  adminApi,
  type AdminConfig,
  type EnforcedGuarantees,
  type ZodIssue,
} from "../api.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";

/** Map zod issues to the first message per dotted field path (e.g. "risk.penaltyPerFlag"). */
function fieldErrors(issues: ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.join(".");
    if (!(key in out)) out[key] = i.message;
  }
  return out;
}

const RISK_FIELDS: {
  key: keyof AdminConfig["risk"];
  label: string;
  step: string;
  hint: string;
}[] = [
  { key: "readinessBase", label: "Readiness base", step: "1", hint: "0–100 · base score before per-flag penalties" },
  { key: "penaltyPerFlag", label: "Penalty per flag", step: "1", hint: "0–100 · points deducted per readiness flag" },
  { key: "staleBeforeYear", label: "Stale-before year", step: "1", hint: "integer · ontology versions before this year are stale" },
  { key: "statisticalConfidence", label: "Statistical confidence", step: "0.01", hint: "0–1 · confidence for the HITL-gated conclusion" },
];

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [enforced, setEnforced] = useState<EnforcedGuarantees | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Raw numeric strings so an invalid entry (e.g. "abc" / "200") reaches the
  // server and surfaces a real zod 400 inline, instead of being silently coerced.
  const [riskRaw, setRiskRaw] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminApi.get();
      setConfig(res.config);
      setEnforced(res.enforced);
      setRiskRaw(
        Object.fromEntries(
          Object.entries(res.config.risk).map(([k, v]) => [k, String(v)])
        )
      );
      setErrors({});
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function setText(key: "narratorSystemPrompt" | "askInstruction" | "notInGraphMarker", value: string) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setErrors({});
    // Build the patch. Risk numbers come from the raw strings; non-numeric stays
    // NaN so the server rejects it (proving real validation, not client coercion).
    const riskPatch: Record<string, number> = {};
    for (const f of RISK_FIELDS) {
      const raw = riskRaw[f.key] ?? "";
      riskPatch[f.key] = raw.trim() === "" ? NaN : Number(raw);
    }
    const patch: Partial<AdminConfig> = {
      narratorSystemPrompt: config.narratorSystemPrompt,
      askInstruction: config.askInstruction,
      notInGraphMarker: config.notInGraphMarker,
      risk: riskPatch as AdminConfig["risk"],
    };
    const result = await adminApi.put(patch);
    setSaving(false);
    if (result.ok) {
      setConfig(result.data.config);
      setEnforced(result.data.enforced);
      setRiskRaw(
        Object.fromEntries(
          Object.entries(result.data.config.risk).map(([k, v]) => [k, String(v)])
        )
      );
      toast.success("Config saved — hot-applied, no restart", {
        description: "The next /narrate, /ask and /risk request uses these values.",
      });
    } else {
      setErrors(fieldErrors(result.issues));
      toast.error(`Save rejected (${result.status})`, {
        description: result.issues.length
          ? `${result.issues.length} field${result.issues.length > 1 ? "s" : ""} failed validation — see inline errors.`
          : result.error,
      });
    }
  }

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      {/* Sheet panel — dialog surface (focus-trapped) */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Admin configuration"
        className="flex h-full w-full max-w-2xl flex-col bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ShieldCheck className="size-5 text-primary" />
              Trust &amp; Guardrail Admin
            </div>
            <p className="text-xs text-muted-foreground">
              Demo admin — edits apply live (hot-apply, no restart). Real auth is deferred.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close admin panel">
            Close
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading config…
            </div>
          )}

          {loadError && (
            <Alert variant="destructive">
              <AlertTitle>Could not load config</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}

          {!loading && config && enforced && (
            <Tabs defaultValue="editable" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="editable">Editable</TabsTrigger>
                <TabsTrigger value="enforced" className="gap-1">
                  <Lock className="size-3.5" /> Enforced (locked)
                </TabsTrigger>
              </TabsList>

              {/* ----- EDITABLE ----- */}
              <TabsContent value="editable" className="space-y-5">
                <FieldGroup
                  id="narratorSystemPrompt"
                  label="Narrator system prompt"
                  hint="Advisory prompt for the narration of the explanation path."
                  error={errors["narratorSystemPrompt"]}
                >
                  <Textarea
                    id="narratorSystemPrompt"
                    rows={4}
                    value={config.narratorSystemPrompt}
                    onChange={(e) => setText("narratorSystemPrompt", e.target.value)}
                  />
                </FieldGroup>

                <FieldGroup
                  id="askInstruction"
                  label="/ask instruction"
                  hint="Tool-loop instruction prefix; the refusal marker is appended structurally."
                  error={errors["askInstruction"]}
                >
                  <Textarea
                    id="askInstruction"
                    rows={3}
                    value={config.askInstruction}
                    onChange={(e) => setText("askInstruction", e.target.value)}
                  />
                </FieldGroup>

                <FieldGroup
                  id="notInGraphMarker"
                  label="Not-in-graph refusal marker"
                  hint="Single source of truth wired to the agent, the AG-UI bridge and the AskPanel. Editing the value is fine; it does not bypass refusal."
                  error={errors["notInGraphMarker"]}
                >
                  <Input
                    id="notInGraphMarker"
                    value={config.notInGraphMarker}
                    onChange={(e) => setText("notInGraphMarker", e.target.value)}
                  />
                </FieldGroup>

                <div>
                  <Label className="mb-2 block">Risk thresholds</Label>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {RISK_FIELDS.map((f) => {
                      const err = errors[`risk.${f.key}`];
                      return (
                        <div key={f.key} className="space-y-1.5">
                          <Label htmlFor={`risk.${f.key}`} className="text-xs">
                            {f.label}
                          </Label>
                          <Input
                            id={`risk.${f.key}`}
                            type="number"
                            step={f.step}
                            value={riskRaw[f.key] ?? ""}
                            aria-invalid={!!err}
                            onChange={(e) =>
                              setRiskRaw((r) => ({ ...r, [f.key]: e.target.value }))
                            }
                          />
                          <p className="text-[11px] text-muted-foreground">{f.hint}</p>
                          {err && (
                            <p role="alert" className="text-[11px] font-medium text-destructive">
                              {err}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-3 border-t pt-4">
                  <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void load()}
                    disabled={saving}
                    title="Discard local edits and reload the current saved config from the server."
                  >
                    <RotateCcw className="size-4" /> Reset to saved
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Save sends a partial PUT; changes hot-apply on the next request.
                  </span>
                </div>
              </TabsContent>

              {/* ----- ENFORCED (LOCKED) ----- */}
              <TabsContent value="enforced">
                <Card className="border-primary/30 bg-secondary/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Lock className="size-4 text-primary" />
                      Structural guarantees — locked, enforced in code
                    </CardTitle>
                    <CardDescription>
                      These are NOT editable and are not read from config. No control here can
                      change them — that is the point: you can tune prompts, but you cannot switch
                      off grounding.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={enforced.neo4jReadOnly ? "default" : "destructive"} className="gap-1">
                        <Lock className="size-3" />
                        Neo4j read-only: {enforced.neo4jReadOnly ? "ON" : "OFF"}
                      </Badge>
                      <Badge variant="default" className="gap-1">
                        <Lock className="size-3" />
                        Grounding refusal: {enforced.groundingRefusalEnforced ? "ENFORCED" : "OFF"}
                      </Badge>
                      <Badge variant="secondary" className="gap-1">
                        <Lock className="size-3" />
                        Write tool excluded: {enforced.excludedWriteTool}
                      </Badge>
                    </div>

                    <div>
                      <div className="mb-1.5 text-xs font-medium text-foreground">
                        Allow-listed tools (read-only)
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {enforced.allowedTools.map((t) => (
                          <Badge key={t} variant="outline" className="gap-1 font-mono text-[11px]">
                            <Lock className="size-3" /> {t}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <Alert>
                      <ShieldCheck className="size-4" />
                      <AlertTitle>Why this cannot be turned off</AlertTitle>
                      <AlertDescription>{enforced.note}</AlertDescription>
                    </Alert>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldGroup({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      {error && (
        <p role="alert" className="text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
