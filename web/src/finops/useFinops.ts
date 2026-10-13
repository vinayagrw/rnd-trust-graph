/**
 * FinOps polling hook — fetches the live session summary on an interval so the
 * header meter + dashboard update for a "live" feel as LLM calls land. Read-only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { finopsApi, type FinOpsSummary } from "../api.js";

export interface UseFinopsResult {
  summary: FinOpsSummary | null;
  error: string | null;
  refresh: () => void;
}

/** Poll GET /api/finops/summary every `intervalMs` (default 4s). A failed poll
 *  keeps the last good value (never blanks the meter mid-demo). `enabled=false`
 *  pauses polling (e.g. when no surface is mounted). */
export function useFinops(intervalMs = 4000, enabled = true): UseFinopsResult {
  const [summary, setSummary] = useState<FinOpsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // Guards setState against a poll/refresh that resolves after unmount (the lone
  // async hook here that previously lacked the alive-flag the others all use).
  const alive = useRef(true);

  const refresh = useCallback(() => {
    finopsApi
      .summary()
      .then((s) => {
        if (!alive.current) return;
        setSummary(s);
        setError(null);
      })
      .catch((e) => {
        if (alive.current) setError(String(e)); // keep last good summary
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    timer.current = window.setInterval(refresh, intervalMs);
    return () => {
      if (timer.current != null) window.clearInterval(timer.current);
    };
  }, [enabled, intervalMs, refresh]);

  // Reset alive on (re)mount, not just clear on unmount. In React StrictMode the
  // dev double-invoke runs mount→cleanup→mount; without restoring `true` here the
  // first cleanup's `alive.current = false` would persist and short-circuit every
  // later setSummary, leaving the meter stuck at the null fallback ($0.00 · 0 tok).
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  return { summary, error, refresh };
}

/** Format a USD cost with enough precision for tiny demo spends. */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Compact token count (1234 -> "1.2k", 1_200_000 -> "1.2M"). */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
