/**
 * NodeContextBar — clicked graph nodes become the conversation's focus.
 *
 * Shared by Beat 4 (the full conversation surface) and the floating AskDock so a
 * node selected on the canvas drives BOTH chats identically. Selection ACCUMULATES:
 * each click toggles a node in/out of the context set (a removable chip per node).
 * With one node selected the pills are node-specific; with two or more they become
 * relational (connections / shared evidence / compare known-missing across them).
 * Each pill submits a NORMAL grounded turn through whatever agent the host passes
 * via `onAsk` — no new answer path, no second LLM.
 */
import type { GraphNode } from "@rnd/shared";

/** Node-specific grounded question suggestions: generic three + one kind-aware
 *  prompt. All answerable from the read-only graph — no new answer path. */
export function nodeQuestions(node: GraphNode): { title: string; message: string }[] {
  const L = node.label;
  const generic = [
    { title: "Evidence", message: `What evidence in the graph supports ${L}?` },
    { title: "Connections", message: `How is ${L} connected in the graph, and to what?` },
    { title: "Known / missing", message: `For ${L}: what is known, what is missing, and what is conflicting?` },
  ];
  const byKind: Record<string, { title: string; message: string }> = {
    AdverseEvent: { title: "Safety signal", message: `What is the safety signal for ${L}?` },
    Drug: { title: "Adverse events", message: `Which adverse events are associated with ${L}?` },
    Target: { title: "Mechanism", message: `What mechanism links ${L} to the myocarditis signal?` },
    BiologicalTarget: { title: "Mechanism", message: `What mechanism links ${L} to the myocarditis signal?` },
    SignalStat: { title: "Disproportionality", message: `What do the disproportionality metrics (PRR/ROR) for ${L} show?` },
  };
  const extra = byKind[String(node.kind)];
  return extra ? [extra, ...generic] : generic;
}

/** Relational grounded suggestions across 2+ selected nodes. Each names every
 *  node's label so the grounded agent reasons over the whole set — still answered
 *  purely from the read-only graph, no new answer path. */
export function multiNodeQuestions(nodes: GraphNode[]): { title: string; message: string }[] {
  const labels = nodes.map((n) => n.label);
  const list = labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return [
    { title: "Connections", message: `How are ${list} connected in the graph, and through what?` },
    { title: "Shared evidence", message: `What evidence in the graph links ${list}?` },
    { title: "Compare known / missing", message: `For ${list}: compare what is known, what is missing, and what is conflicting.` },
  ];
}

/** The context bar: one removable node chip per selected node + grounded question
 *  pills (node-specific for one node, relational for many). Purely presentational —
 *  the host wires `onAsk` to its own grounded agent. */
export function NodeContextBar({
  nodes,
  onRemove,
  onClearAll,
  onAsk,
}: {
  nodes: GraphNode[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onAsk: (message: string) => void;
}) {
  if (nodes.length === 0) return null;
  const qs = nodes.length === 1 ? nodeQuestions(nodes[0]) : multiNodeQuestions(nodes);
  return (
    <div style={{ padding: "8px 10px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--frame-text-muted)" }}>
          {nodes.length > 1 ? `Context · ${nodes.length}` : "Context"}
        </span>
        {nodes.map((node) => (
          <span
            key={node.id}
            title={`${node.kind} · ${node.id}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              padding: "3px 4px 3px 8px",
              borderRadius: 999,
              border: "1px solid var(--frame-border)",
              background: "rgba(45,212,191,.12)",
              color: "var(--frame-text)",
              maxWidth: 240,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "#2dd4bf", flex: "0 0 auto" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.label}</span>
            <button
              type="button"
              onClick={() => onRemove(node.id)}
              title={`Remove ${node.label}`}
              aria-label={`Remove ${node.label}`}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--frame-text-muted)",
                cursor: "pointer",
                width: 16,
                height: 16,
                borderRadius: 4,
                fontSize: 13,
                lineHeight: 1,
                flex: "0 0 auto",
              }}
            >
              ×
            </button>
          </span>
        ))}
        {nodes.length > 1 && (
          <button
            type="button"
            onClick={onClearAll}
            title="Clear all context"
            aria-label="Clear all context"
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 999,
              border: "1px solid var(--frame-border)",
              background: "transparent",
              color: "var(--frame-text-muted)",
              cursor: "pointer",
            }}
          >
            Clear all
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {qs.map((q) => (
          <button
            key={q.title}
            type="button"
            onClick={() => onAsk(q.message)}
            title={q.message}
            style={{
              fontSize: 12,
              padding: "5px 10px",
              borderRadius: 999,
              border: "1px solid var(--frame-border)",
              background: "rgba(88,166,255,.10)",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            {q.title}
          </button>
        ))}
      </div>
    </div>
  );
}
