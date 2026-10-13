/**
 * Minimal React error boundary. React render errors don't reach window.onerror,
 * so this is what locates them: it logs the error + componentStack through the
 * located logger (so you get file:line fn()) and renders a plain fallback rather
 * than a blank white screen.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "../lib/log.js";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("React render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          padding: "24px",
          margin: "24px auto",
          maxWidth: 520,
          fontFamily: "system-ui, sans-serif",
          color: "#e8eef6",
          background: "#12233f",
          border: "1px solid #2a4675",
          borderRadius: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Something went wrong.</div>
        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>
          The interface hit an unexpected error. Details were logged to the console.
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid #2a4675",
            background: "#16294a",
            color: "#e8eef6",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
