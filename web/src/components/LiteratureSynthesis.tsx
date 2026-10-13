/**
 * F7 — Literature evidence synthesis (web). A self-contained section that streams
 * a source-ranked, inline-cited synthesis over the graph's LiteratureAbstract nodes
 * for a focus node (and/or topic). It renders the ranked sources first (provenance
 * up front), then the narrative with every [LIT-PMID-…] turned into a clickable
 * chip, plus a grounded/fallback badge. All content comes from the BFF stream — the
 * component invents nothing; the server enforces that inline citations are ⊆ the
 * supplied abstracts.
 */
import { useRef, useState } from "react";
import type { GraphPayload, RankedAbstract, StreamEvent } from "@rnd/shared";
import { litsynth, api } from "../api.js";
import { resolveCited } from "../lib/evidence.js";

const LIT_ID_RE = /(LIT-PMID-[0-9]+)/g; // split (capturing) — keeps the ids as tokens
const LIT_ID_ONE = /^LIT-PMID-[0-9]+$/; // anchored, non-global — safe for per-token tests

export function LiteratureSynthesis({
  focusNodeId,
  topic,
  graph,
  onCiteClick,
}: {
  focusNodeId?: string;
  topic?: string;
  /** When omitted, the component fetches the graph itself (for label tooltips +
   *  the "resolved in graph" count). */
  graph?: GraphPayload;
  onCiteClick?: (nodeId: string) => void;
}) {
  const [ranked, setRanked] = useState<RankedAbstract[]>([]);
  const [narrative, setNarrative] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const [isFallback, setIsFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [graphState, setGraphState] = useState<GraphPayload>(
    graph ?? { nodes: [], edges: [] },
  );
  const cancelRef = useRef<null | (() => void)>(null);

  function run() {
    cancelRef.current?.();
    setBusy(true);
    setStarted(true);
    setRanked([]);
    setNarrative("");
    setCited([]);
    setIsFallback(false);
    if (!graph && graphState.nodes.length === 0) {
      api.graph("all").then(setGraphState).catch(() => {});
    }
    let acc = "";
    cancelRef.current = litsynth({ focusNodeId, topic }, (e: StreamEvent) => {
      if (e.type === "ranked") setRanked(e.ranked);
      else if (e.type === "token") setNarrative((acc += e.text));
      else if (e.type === "citations") setCited(e.nodeIds);
      else if (e.type === "done") {
        setIsFallback(e.isFallback);
        setBusy(false);
      } else if (e.type === "error") {
        setNarrative("(offline — could not reach the synthesis service)");
        setIsFallback(true);
        setBusy(false);
      }
    });
  }

  const activeGraph = graph ?? graphState;
  const labelById = new Map(activeGraph.nodes.map((n) => [n.id, n.label] as const));
  const grounded = started && !busy && !isFallback;

  // Render the narrative with inline [LIT-PMID-…] ids as clickable chips.
  const parts = narrative.split(LIT_ID_RE);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {!started && (
        <button
          type="button"
          onClick={run}
          style={btn}
          title="Synthesize the linked literature, source-ranked and inline-cited"
        >
          ▤ Synthesize literature
        </button>
      )}

      {started && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--frame-text)" }}>
              Literature synthesis
            </span>
            {!busy && (
              <span
                style={{
                  fontSize: 10.5,
                  padding: "1px 7px",
                  borderRadius: 999,
                  background: grounded ? "rgba(16,128,80,.12)" : "rgba(180,120,0,.14)",
                  color: grounded ? "#0a7d4b" : "#9a6a00",
                  border: `1px solid ${grounded ? "rgba(16,128,80,.35)" : "rgba(180,120,0,.35)"}`,
                }}
              >
                {grounded ? "grounded" : "offline / template"}
              </span>
            )}
            {busy && <span style={{ fontSize: 10.5, color: "var(--frame-muted)" }}>streaming…</span>}
          </div>

          {/* Ranked sources — provenance up front. */}
          {ranked.length > 0 && (
            <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
              {ranked.map((r) => (
                <li key={r.nodeId} style={{ fontSize: 11.5, color: "var(--frame-muted)" }}>
                  <button type="button" onClick={() => onCiteClick?.(r.nodeId)} style={chip}>
                    {r.nodeId}
                  </button>{" "}
                  <span style={{ color: "var(--frame-text)" }}>{r.title}</span>{" "}
                  <span style={{ opacity: 0.75 }}>
                    · {r.tierLabel}
                    {r.year ? `, ${r.year}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {/* Narrative with clickable inline citations. */}
          {narrative && (
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--frame-text)", margin: 0 }}>
              {parts.map((p, i) =>
                LIT_ID_ONE.test(p) ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onCiteClick?.(p)}
                    style={chip}
                    title={labelById.get(p) ?? p}
                  >
                    {p}
                  </button>
                ) : (
                  <span key={i}>{p}</span>
                ),
              )}
            </p>
          )}

          {!busy && cited.length > 0 && (
            <div style={{ fontSize: 10.5, color: "var(--frame-muted)" }}>
              {cited.length} source{cited.length === 1 ? "" : "s"} cited ·{" "}
              {resolveCited(cited, activeGraph).length} resolved in graph
            </div>
          )}
        </>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 12,
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--frame-border)",
  background: "var(--frame-surface)",
  color: "var(--frame-text)",
  cursor: "pointer",
  alignSelf: "flex-start",
};

const chip: React.CSSProperties = {
  fontSize: 10.5,
  fontFamily: "var(--font-mono, monospace)",
  padding: "0 4px",
  borderRadius: 4,
  border: "1px solid var(--frame-border)",
  background: "var(--frame-bg, rgba(0,0,0,.03))",
  color: "var(--frame-accent, #2563eb)",
  cursor: "pointer",
};
