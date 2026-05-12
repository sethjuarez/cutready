import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/lora/400.css";
import "@fontsource/lora/400-italic.css";
import "@fontsource/lora/600.css";
import "@fontsource/lora/700.css";
import "./index.css";

// Install dev mocks when running in browser without Tauri runtime.
// Some screenshot/documentation runs set NODE_ENV=production while Vite still
// serves in development mode, so use MODE instead of DEV here.
const isViteDevelopment = import.meta.env.MODE === "development";
if (isViteDevelopment && !(window as any).__TAURI_INTERNALS__) {
  const { installDevMocks } = await import("./devMock");
  installDevMocks();
  // Expose appStore for dev tooling and Playwright screenshot scripts
  const { useAppStore } = await import("./stores/appStore");
  (window as any).__appStore = useAppStore;
}

// Pipe JS errors and warnings to the Rust log plugin so they land in the
// release log file under %LOCALAPPDATA%\com.cutready.app\logs (issue #64).
// Noisy console.log/info forwarding stays dev-only to keep release logs
// readable.
if ((window as any).__TAURI_INTERNALS__) {
  import("@tauri-apps/plugin-log").then(({ error: logError, warn: logWarn, info: logInfo, debug: logDebug }) => {
    window.addEventListener("error", (e) => {
      logError(`[JS] ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      logError(`[JS:unhandled] ${e.reason}`);
    });
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      origConsoleError.apply(console, args);
      logError(`[console.error] ${args.map(String).join(" ")}`);
    };
    const origConsoleWarn = console.warn;
    console.warn = (...args: any[]) => {
      origConsoleWarn.apply(console, args);
      logWarn(`[console.warn] ${args.map(String).join(" ")}`);
    };

    if (isViteDevelopment) {
      const origConsoleLog = console.log;
      console.log = (...args: any[]) => {
        origConsoleLog.apply(console, args);
        logInfo(`[console.log] ${args.map(String).join(" ")}`);
      };
      const origConsoleInfo = console.info;
      console.info = (...args: any[]) => {
        origConsoleInfo.apply(console, args);
        logDebug(`[console.info] ${args.map(String).join(" ")}`);
      };
    }
  });
}

// Detect capture window mode via initialization script flag
// (set by Rust open_capture_window via WebviewWindowBuilder::initialization_script)
declare global {
  interface Window {
    __IS_CAPTURE?: boolean;
    __IS_RECORDING_COUNTDOWN?: boolean;
    __IS_RECORDING_CONTROL?: boolean;
    __IS_PREVIEW?: boolean;
  }
}

const isCaptureMode = !!window.__IS_CAPTURE;
const isRecordingCountdownMode = !!window.__IS_RECORDING_COUNTDOWN;
const isRecordingControlMode = !!window.__IS_RECORDING_CONTROL;
const isPreviewMode = !!window.__IS_PREVIEW;
console.log(`[main.tsx] isCaptureMode=${isCaptureMode} isRecordingCountdownMode=${isRecordingCountdownMode} isRecordingControlMode=${isRecordingControlMode} isPreviewMode=${isPreviewMode} href=${window.location.href}`);

async function renderApp() {
  if (isCaptureMode) {
    document.documentElement.dataset.themeReady = "true";
    // No StrictMode for capture window — it uses events for IPC
    const { CaptureWindow } = await import("./components/CaptureWindow");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <CaptureWindow />,
    );
  } else if (isRecordingCountdownMode) {
    document.documentElement.dataset.themeReady = "true";
    const { RecordingCountdownWindow } = await import("./components/RecordingCountdownWindow");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <RecordingCountdownWindow />,
    );
  } else if (isRecordingControlMode) {
    document.documentElement.dataset.themeReady = "true";
    const { RecordingControlWindow } = await import("./components/RecordingControlWindow");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <RecordingControlWindow />,
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
