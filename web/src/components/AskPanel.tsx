/**
 * Ask-the-graph-anything — 2026 "show your work" answer card.
 * Past the chat box: the agent's actual read-only Cypher and the rows it
 * returned stream as first-class UI (re-runnable = trustworthy), the answer is
 * badged "grounded in live Cypher", and an out-of-graph question is REFUSED
 * (principled refusal) rather than hallucinated. Falls back safely offline.
 */
import { useEffect, useState } from "react";
import type { FallbackReason } from "@rnd/shared";
import { api, stream } from "../api.js";
import { Button } from "./ui/button.js";

const SUGGESTIONS = [
  "What's the safety signal?",
  "How does the drug cause it?",
  "What evidence supports it?",
];

/** The refusal marker is configured server-side (single source of truth shared by
 *  the agent, the AG-UI bridge, and this UI). Fetched from /api/config/public so
 *  an admin edit can't desync detection. Falls back to the default literal until
 *  the fetch resolves / if the BFF is unreachable. */
const DEFAULT_REFUSE_MARKER = "NOT_IN_GRAPH:";

/** Plain-English explanation of why a live answer dropped to the safe fallback. */
const REASON_HINT: Record<FallbackReason, string> = {
  disabled: "Live mode is off — set LLM_PROVIDER=claude-code in bff/.env.",
  "spawn-failed": "`claude` CLI not found on PATH.",
  "not-authenticated": "Claude Code isn't logged in — run `claude` once to sign in.",
  "no-tools": "Neo4j MCP didn't connect — is `uvx` installed and Neo4j up?",
  timeout: "The agent took too long and was cut off.",
  "empty-output": "The agent returned no text.",
  ungrounded: "The answer referenced something off the graph and was refused.",
  "api-error": "The cloud API call failed.",
};

export function AskPanel() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [cypher, setCypher] = useState<string[]>([]);
  const [rows, setRows] = useState<string[]>([]);
  const [showWork, setShowWork] = useState(true);
  const [isFallback, setIsFallback] = useState(false);
  const [reason, setReason] = useState<FallbackReason>();
  const [busy, setBusy] = useState(false);
  const [refuseMarker, setRefuseMarker] = useState(DEFAULT_REFUSE_MARKER);

  useEffect(() => {
    api
      .publicConfig()
      .then((c) => c.notInGraphMarker && setRefuseMarker(c.notInGraphMarker))
      .catch(() => {
        /* keep the default marker if the BFF is unreachable */
      });
  }, []);

  function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    setAnswer("");
    setSteps([]);
    setCypher([]);
    setRows([]);
    setIsFallback(false);
    setReason(undefined);
    let acc = "";
    stream("/ask", { beatId: "ask", question }, (e) => {
      if (e.type === "token") setAnswer((acc += e.text));
      else if (e.type === "step") setSteps((s) => [...s, e.label]);
      else if (e.type === "cypher") setCypher((c) => [...c, e.query]);
      else if (e.type === "rows") setRows((r) => [...r, e.preview]);
      else if (e.type === "done") {
        setIsFallback(e.isFallback);
        setReason(e.reason);
        setBusy(false);
      } else if (e.type === "error") {
        setAnswer("(offline — could not reach the graph agent)");
        setIsFallback(true);
        setBusy(false);
      }
    });
  }

  const refused = answer.includes(refuseMarker);
  const answerText = refused
    ? answer.slice(answer.indexOf(refuseMarker) + refuseMarker.length).trim()
    : answer;
  const grounded = !isFallback && !refused && cypher.length > 0;

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--frame-border)", paddingTop: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
        Ask the graph anything
      </div>
      <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(q)}
          placeholder="e.g. what's the safety signal?"
          style={{ flex: 1, padding: "6px 8px", border: "1px solid var(--frame-border)", borderRadius: 6 }}
        />
        <Button variant="control" size="brand" onClick={() => ask(q)} disabled={busy}>
          {busy ? "…" : "Ask"}
        </Button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {SUGGESTIONS.map((s) => (
          <Button
            key={s}
            variant="chip"
            size="brand"
            onClick={() => {
              setQ(s);
              ask(s);
            }}
          >
            {s}
          </Button>
        ))}
      </div>

      {/* Show-your-work trace: steps + the real Cypher + the rows it returned. */}
      {(steps.length > 0 || cypher.length > 0) && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="btn"
            onClick={() => setShowWork((v) => !v)}
            style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, border: "1px solid var(--frame-border)", background: "var(--frame-bg)" }}
          >
            {showWork ? "▾" : "▸"} Show the agent's work ({cypher.length} quer{cypher.length === 1 ? "y" : "ies"})
          </button>
          {showWork && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {steps.map((s, i) => (
                <div key={`s${i}`} style={{ fontSize: 12, color: "var(--frame-text-muted)" }}>
                  • {s}
                </div>
              ))}
              {cypher.map((c, i) => (
                <div key={`c${i}`}>
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      borderRadius: 6,
                      background: "#0d1117",
                      color: "#79c0ff",
                      fontSize: 11.5,
                      lineHeight: 1.4,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {c}
                  </pre>
                  {rows[i] && (
                    <div
                      style={{
                        fontFamily: "ui-monospace, Menlo, monospace",
                        fontSize: 11,
                        color: "#8b949e",
                        padding: "3px 8px",
                      }}
                    >
                      → {rows[i]}
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>
                Read-only · the agent can run Cypher but never write.
              </div>
            </div>
          )}
        </div>
      )}

      {answer ? (
        <div style={{ fontSize: 14, margin: 0 }}>
          {refused && (
            <div
              style={{
                display: "inline-block",
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: "rgba(210,153,34,.15)",
                color: "#d29922",
                border: "1px solid rgba(210,153,34,.5)",
                marginBottom: 6,
              }}
              title="The graph doesn't contain this — the agent refused rather than guess."
            >
              ⚠ not in the graph — refused, not guessed
            </div>
          )}
          <p style={{ margin: 0 }}>
            {answerText}{" "}
            {grounded && (
              <span
                className="badge-live"
                title="This answer was derived by running read-only Cypher against the live graph — re-runnable above."
                style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999 }}
              >
                ✓ grounded in live Cypher
              </span>
            )}
            {isFallback && (
              <span
                className="badge-fallback"
                title={reason ? REASON_HINT[reason] : undefined}
                style={{ cursor: reason ? "help" : "default" }}
              >
                read-only fallback{reason ? ` · ${reason}` : ""}
              </span>
            )}
          </p>
        </div>
      ) : (
        !busy && (
          <p style={{ fontSize: 12, margin: 0, color: "var(--frame-text-muted)" }}>
            Answers run read-only Cypher against the live graph, show their work, and cite what they
            touch — the agent can only read, never write, and refuses what isn't in the graph.
          </p>
        )
      )}
    </div>
  );
}
