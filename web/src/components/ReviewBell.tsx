/**
 * Review notification bell — a compact header control that surfaces how many
 * governance items are awaiting a human decision in the HITL queue, and opens a
 * dropdown listing the top items inline. A standard "notifications" affordance,
 * but grounded: the list IS GET /api/hitl/pending (curated review scenarios +
 * anything Send→Review enqueued), never a fabricated number.
 *
 * Styled to match the other header controls (reuses the shadcn Button
 * `control`/`brand` idiom + the frame CSS vars). Polls on a slow cadence and also
 * re-pulls whenever `refreshKey` changes (i.e. after a governed apply/revert), so
 * approving an item drops the count immediately.
 */
import { useEffect, useRef, useState } from "react";
import type { HitlPendingItem } from "@rnd/shared";
import { Button } from "./ui/button.js";
import { hitlApi } from "../api.js";

const PREVIEW = 5; // how many items to show inline before "view all"

export function ReviewBell({
  onOpen,
  refreshKey,
}: {
  /** Open the full HITL panel (footer link + per-row click). */
  onOpen: () => void;
  /** Bump to force an immediate re-pull (e.g. after a HITL apply/revert). */
  refreshKey?: number;
}) {
  const [items, setItems] = useState<HitlPendingItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      hitlApi
        .pending()
        .then((list) => alive && setItems(list))
        .catch(() => {}); // a failed poll keeps the last good list — never blanks
    pull();
    const t = window.setInterval(pull, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [refreshKey]);

  // Close on outside-click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const n = items?.length ?? 0;
  const has = n > 0;
  const openFull = () => {
    setOpen(false);
    onOpen();
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <Button
        variant="control"
        size="brand"
        onClick={() => setOpen((v) => !v)}
        title={
          has
            ? `${n} governance item${n === 1 ? "" : "s"} awaiting human review`
            : "No items awaiting review"
        }
        aria-label={`Notifications: ${n} items awaiting review`}
        aria-expanded={open}
        style={{ position: "relative" }}
      >
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
          &#x1F514;
        </span>
        {has && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -5,
              right: -5,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 999,
              background: "#de4a3b",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "16px",
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
              boxShadow: "0 1px 3px rgba(0,0,0,.4)",
            }}
          >
            {n > 99 ? "99+" : n}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            // Anchor LEFT, not right: the bell sits near the left of the header, so a
            // right-anchored 340px list opened leftward off the screen edge and was
            // clipped. Opening rightward keeps the whole notification list on-screen.
            left: 0,
            width: 340,
            maxHeight: "min(70vh, 520px)",
            overflowY: "auto",
            zIndex: 1200,
            background: "var(--frame-surface)",
            color: "var(--frame-text)",
            border: "1px solid var(--frame-border)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,.35)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              borderBottom: "1px solid var(--frame-border)",
              position: "sticky",
              top: 0,
              background: "var(--frame-surface)",
            }}
          >
            <strong style={{ fontSize: 13 }}>Awaiting review</strong>
            <span
              style={{
                fontSize: 11,
                color: "var(--frame-text-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {n} pending
            </span>
          </div>

          {items === null ? (
            <div style={{ padding: 14, fontSize: 12, color: "var(--frame-text-muted)" }}>Loading…</div>
          ) : n === 0 ? (
            <div style={{ padding: 14, fontSize: 12, color: "var(--frame-text-muted)" }}>
              Nothing awaiting review. New governance items and Send→Review requests appear here.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 4 }}>
              {items.slice(0, PREVIEW).map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openFull}
                    title={it.effect}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "none",
                      background: "transparent",
                      color: "var(--frame-text)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(127,127,127,.12)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12.5,
                        fontWeight: 600,
                      }}
                    >
                      <span aria-hidden style={{ color: "#e0a93b" }}>&#x2696;</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.title}
                      </span>
                    </div>
                    {it.targetNodeId && (
                      <div style={{ marginTop: 3 }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: "1px solid var(--frame-border)",
                            color: "var(--frame-text-muted)",
                          }}
                        >
                          {it.targetNodeId}
                        </span>
                      </div>
                    )}
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11.5,
                        lineHeight: 1.35,
                        color: "var(--frame-text-muted)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {it.effect}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div style={{ borderTop: "1px solid var(--frame-border)", padding: 6 }}>
            <button
              type="button"
              onClick={openFull}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                padding: "8px 10px",
                borderRadius: 7,
                border: "none",
                background: "transparent",
                color: "var(--frame-accent, #58a6ff)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {n > PREVIEW ? `View all ${n} in the HITL queue →` : "Open the HITL queue →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
