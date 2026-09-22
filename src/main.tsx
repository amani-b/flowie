import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import ErrorBoundary from "./components/ErrorBoundary";

// A missing #root (stale PWA shell, bad deploy) used to throw outside React
// and leave a dead blank page. Fail visibly instead of silently.
const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML =
    '<div style="padding:32px;font-family:system-ui;text-align:center">' +
    "<h1>Flowie couldn't start</h1>" +
    "<p>Please refresh. If this persists, clear the site data and reload.</p></div>";
} else {
  ReactDOM.createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
