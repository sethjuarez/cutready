import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "./index.css";

// Install dev mocks when running in browser without Tauri runtime
if (import.meta.env.DEV && !(window as any).__TAURI_INTERNALS__) {
  const { installDevMocks } = await import("./devMock");
  installDevMocks();
}

// Detect capture window mode via initialization script flag
// (set by Rust open_capture_window via WebviewWindowBuilder::initialization_script)
declare global {
  interface Window {
    __IS_CAPTURE?: boolean;
    __IS_PREVIEW?: boolean;
  }
}

const isCaptureMode = !!window.__IS_CAPTURE;
const isPreviewMode = !!window.__IS_PREVIEW;
console.log(`[main.tsx] isCaptureMode=${isCaptureMode} isPreviewMode=${isPreviewMode} href=${window.location.href}`);

async function renderApp() {
  if (isCaptureMode) {
    // No StrictMode for capture window — it uses events for IPC
    const { CaptureWindow } = await import("./components/CaptureWindow");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <CaptureWindow />,
    );
  } else if (isPreviewMode) {
    const { StandalonePreview } = await import("./components/StandalonePreview");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <StandalonePreview />,
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
