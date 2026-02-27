import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "./index.css";

// Detect capture window mode via query parameter
const params = new URLSearchParams(window.location.search);
const isCaptureMode = params.get("mode") === "capture";

async function renderApp() {
  if (isCaptureMode) {
    const { CaptureWindow } = await import("./components/CaptureWindow");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <CaptureWindow params={params} />
      </React.StrictMode>,
    );
  } else {
    const App = (await import("./App")).default;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

renderApp();

