import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { ReviewerProvider } from "./identity/ReviewerContext.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { log } from "./lib/log.js";
import "./theme/tokens.css";

// Global safety nets so nothing fails silently: uncaught errors and unhandled
// promise rejections are logged with file:line via the located logger.
window.addEventListener("error", (e) => log.error("window error:", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => log.error("unhandled rejection:", e.reason));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ReviewerProvider>
        <App />
      </ReviewerProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
