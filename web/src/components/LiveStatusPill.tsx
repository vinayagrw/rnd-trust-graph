/**
 * Presenter live-readiness pill. Polls /api/diag so the room can SEE whether the
 * app is really running live (local Claude Code, no API key) vs scripted
 * fallback — and, on hover, exactly what's missing. Answers "is this real?"
 * before anyone has to ask.
 */
import { useEffect, useState } from "react";
import type { LiveStatus } from "@rnd/shared";
import { api } from "../api.js";

export function LiveStatusPill() {
  const [s, setS] = useState<LiveStatus>();
  const [hover, setHover] = useState(false);

  async function refresh() {
    try {
      setS(await api.diag());
    } catch {
      setS(undefined);
    }
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  const live = s?.live ?? false;
  const label = !s
    ? "checking…"
    : live
      ? s.provider === "claude-code"
        ? "Live · Claude"
        : "Live · cloud API"
      : "Scripted / fallback";

  return (
    <span
      style={{ position: "relative", cursor: "default" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className={live ? "badge-live" : ""}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 8px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.3)",
        }}
        onClick={refresh}
        title="Click to re-check live readiness"
      >
        <span style={{ color: live ? "#3fb950" : "#d29922" }}>{live ? "●" : "○"}</span>
        {label}
      </span>
      {hover && s && (
        <span
          style={{
            position: "absolute",
            top: "120%",
            right: 0,
            zIndex: 20,
            width: 260,
            background: "#14181f",
            color: "#e6edf3",
            border: "1px solid rgba(255,255,255,.15)",
            borderRadius: 8,
            padding: 10,
            fontSize: 12,
            lineHeight: 1.4,
            boxShadow: "0 6px 24px rgba(0,0,0,.4)",
          }}
        >
          <div style={{ marginBottom: 6 }}>{s.detail}</div>
          <Check ok={s.checks.claudeBin} label="claude CLI on PATH" show={s.provider === "claude-code"} />
          <Check ok={s.checks.uvx} label="uvx (for /ask MCP)" show={s.provider === "claude-code"} />
          <Check ok={s.checks.apiKey} label="API key set" show={s.provider === "api"} />
          <Check ok={s.checks.neo4j} label="Neo4j reachable" show />
        </span>
      )}
    </span>
  );
}

function Check({ ok, label, show }: { ok: boolean; label: string; show: boolean }) {
  if (!show) return null;
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <span style={{ color: ok ? "#3fb950" : "#f85149" }}>{ok ? "✓" : "✗"}</span>
      <span>{label}</span>
    </div>
  );
}
