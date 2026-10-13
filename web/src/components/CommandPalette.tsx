/**
 * Command palette (⌘K / Ctrl+K) — one keyboard-driven launcher for the whole app.
 * Three kinds of entry, all grounded in state the app already holds:
 *   - Go to … : switch beats
 *   - Actions : the same things the header buttons do (HITL, Admin, FinOps, Export
 *               RDF, canvas/skin/density toggles) — passed in as Command[]
 *   - Nodes   : jump to any node in the live graph (selects it → opens its dossier)
 *
 * No new data path: nodes come from the already-fetched payload, commands are the
 * host's existing callbacks. Arrow keys move, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "@rnd/shared";
import { useFocusTrap } from "../lib/useFocusTrap.js";

export interface Command {
  id: string;
  label: string;
  /** Short right-aligned hint (e.g. a shortcut or current value). */
  hint?: string;
  group: string;
  run: () => void;
}

interface Entry {
  key: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

const NODE_CAP = 24; // cap node matches so the list stays scannable

export function CommandPalette({
  open,
  onClose,
  commands,
  nodes,
  onSelectNode,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  nodes: GraphNode[];
  onSelectNode: (node: GraphNode) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Reset query/selection each time it opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      // focus after paint
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const needle = q.trim().toLowerCase();
    const cmds = commands.filter((c) => !needle || c.label.toLowerCase().includes(needle));
    const cmdEntries: Entry[] = cmds.map((c) => ({
      key: `cmd:${c.id}`,
      label: c.label,
      hint: c.hint,
      group: c.group,
      run: c.run,
    }));
    const nodeMatches = (needle ? nodes.filter(
      (n) => n.label.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle),
    ) : nodes
    ).slice(0, NODE_CAP);
    const nodeEntries: Entry[] = nodeMatches.map((n) => ({
      key: `node:${n.id}`,
      label: n.label,
      hint: String(n.kind),
      group: "Nodes",
      run: () => onSelectNode(n),
    }));
    return [...cmdEntries, ...nodeEntries];
  }, [q, commands, nodes, onSelectNode]);

  // Keep selection in range as the list shrinks/grows.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  // Scroll the selected row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Esc closes globally — the dialog's own onKeyDown only fires while focus is
  // inside it; this guarantees Esc works even if focus has moved elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const run = (i: number) => {
    const e = entries[i];
    if (!e) return;
    onClose();
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";

  return (
    <div
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        style={{
          width: "min(640px, 92vw)",
          background: "var(--frame-surface)",
          color: "var(--frame-text)",
          border: "1px solid var(--frame-border)",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,.45)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search beats, actions, and nodes…"
          aria-label="Command palette search"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 16px",
            fontSize: 15,
            border: "none",
            borderBottom: "1px solid var(--frame-border)",
            background: "transparent",
            color: "var(--frame-text)",
            outline: "none",
          }}
        />
        <div ref={listRef} style={{ maxHeight: "52vh", overflowY: "auto", padding: 6 }}>
          {entries.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--frame-text-muted)" }}>
              No matches.
            </div>
          ) : (
            entries.map((e, i) => {
              const header = e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              return (
                <div key={e.key}>
                  {header && (
                    <div
                      style={{
                        fontSize: 10.5,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        color: "var(--frame-text-muted)",
                        padding: "8px 10px 4px",
                      }}
                    >
                      {header}
                    </div>
                  )}
                  <button
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setSel(i)}
                    onClick={() => run(i)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 10px",
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      background: i === sel ? "rgba(88,166,255,.16)" : "transparent",
                      color: "var(--frame-text)",
                      fontSize: 13.5,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.label}
                    </span>
                    {e.hint && (
                      <span
                        style={{
                          flex: "0 0 auto",
                          fontSize: 11,
                          color: "var(--frame-text-muted)",
                        }}
                      >
                        {e.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            padding: "8px 12px",
            borderTop: "1px solid var(--frame-border)",
            fontSize: 11,
            color: "var(--frame-text-muted)",
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
