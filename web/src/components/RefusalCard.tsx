export function RefusalCard({ suggestions, onAsk }: { suggestions: string[]; onAsk: (q: string) => void }) {
  return (
    <div data-testid="refusal-card" style={{ border: "1px solid var(--frame-border)", borderLeft: "3px solid rgba(88,166,255,.9)", borderRadius: 6, padding: "10px 12px", margin: "6px 0", background: "rgba(88,166,255,.06)" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>I answer only from the grounded graph — that isn't in it yet.</div>
      <div style={{ fontSize: 12, color: "var(--frame-text-muted)", margin: "4px 0 8px" }}>Try one of these grounded questions:</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {suggestions.map((s) => (
          <button key={s} type="button" onClick={() => onAsk(s)} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--frame-border)", background: "rgba(88,166,255,.10)", color: "var(--frame-text)", cursor: "pointer" }}>{s}</button>
        ))}
      </div>
    </div>
  );
}
