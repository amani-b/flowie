import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import ErrorBoundary from "./components/ErrorBoundary";
import { installTelemetry, markStage } from "./lib/telemetry";

// Dev-only observation layer (no-op in production): stage timings,
// long-task capture, window error funnel. Installed before React mounts so
// a throw during the first render is still observable.
installTelemetry();
markStage("main:start");

// A missing #root (stale PWA shell, bad deploy) used to throw outside React
// and leave a dead blank page. Fail visibly instead of silently.
const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML =
    '<div style="padding:32px;font-family:system-ui;text-align:center">' +
    "<h1>Flowie couldn't start</h1>" +
    "<p>Please refresh. If this persists, clear the site data and reload.</p></div>";
} else {
  markStage("main:mount");
  ReactDOM.createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
