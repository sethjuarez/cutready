import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, SquareTerminal } from "lucide-react";
import { Channel, invoke } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";

type TerminalOpenResult = {
  session_id: string;
  cwd: string;
  shell: string;
};

type TerminalStatus = "idle" | "opening" | "open" | "error";
type TerminalOutput = number[] | ArrayBuffer | Uint8Array;
type TerminalColorMode = "console" | "app";

function readThemeColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  return raw.startsWith("#") || raw.startsWith("rgb") ? raw : `rgb(${raw})`;
}

function encoder() {
  return new TextEncoder();
}

function outputBytes(data: TerminalOutput) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function terminalTheme(mode: TerminalColorMode) {
  if (mode === "app") {
    return {
      background: readThemeColor("--color-surface-inset", "#1f1d1a"),
      foreground: readThemeColor("--color-text", "#f5f1ea"),
      cursor: readThemeColor("--color-accent", "#a49afa"),
      selectionBackground: readThemeColor("--color-accent", "#6b5ce7"),
    };
  }

  return {
    background: "#0c0c0c",
    foreground: "#cccccc",
    cursor: "#ffffff",
    selectionBackground: "#3a3d41",
    black: "#0c0c0c",
    red: "#c50f1f",
    green: "#13a10e",
    yellow: "#c19c00",
    blue: "#0037da",
    magenta: "#881798",
    cyan: "#3a96dd",
    white: "#cccccc",
    brightBlack: "#767676",
    brightRed: "#e74856",
    brightGreen: "#16c60c",
    brightYellow: "#f9f1a5",
    brightBlue: "#3b78ff",
    brightMagenta: "#b4009e",
    brightCyan: "#61d6d6",
    brightWhite: "#f2f2f2",
  };
}

export function TerminalPanel({ active }: { active: boolean }) {
  const currentProject = useAppStore((state) => state.currentProject);
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const openingRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<TerminalOpenResult | null>(null);

  const hasProject = Boolean(currentProject);
  const terminalFontFamily = settings.displayTerminalFontFamily || '"Cascadia Code", Consolas, monospace';
  const terminalFontSize = settings.displayTerminalFontSize || 12;
  const terminalColorMode = settings.displayTerminalColorMode === "app" ? "app" : "console";
  const theme = useMemo(() => terminalTheme(terminalColorMode), [terminalColorMode]);
  const projectRoot = currentProject?.root ?? null;
  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
    containerRef.current
      ?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
      ?.focus({ preventScroll: true });
  }, []);
  const fitTerminal = useCallback(() => {
    const element = containerRef.current;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!element || !terminal || !fit || element.clientWidth === 0 || element.clientHeight === 0) return null;

    fit.fit();

    // xterm's DOM renderer can paint the final column slightly past the WebView edge on Windows.
    // Keep a small right-side gutter so box-drawing prompts never escape the panel.
    const safeCols = Math.max(2, terminal.cols - 3);
    if (safeCols !== terminal.cols) terminal.resize(safeCols, terminal.rows);

    return { cols: terminal.cols, rows: terminal.rows };
  }, []);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontFamily = terminalFontFamily;
    term.options.fontSize = terminalFontSize;
    term.options.theme = theme;
    fitTerminal();
  }, [fitTerminal, terminalFontFamily, terminalFontSize, theme]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      fitTerminal();
      focusTerminal();
    });
  }, [active, fitTerminal, focusTerminal]);

  useEffect(() => {
    if (!hasProject || !projectRoot || !containerRef.current || openingRef.current || terminalRef.current) return;

    openingRef.current = true;
    setSessionInfo(null);
    let disposed = false;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: terminalFontFamily,
      fontSize: terminalFontSize,
      scrollback: 10_000,
      theme,
    });
    const fit = new FitAddon();
    terminalRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerRef.current);
    window.requestAnimationFrame(focusTerminal);

    const openTerminal = async () => {
      setStatus("opening");
      setError(null);
      const channel = new Channel<TerminalOutput>();
      channel.onmessage = (data) => {
        if (!disposed) term.write(outputBytes(data));
      };

      try {
        const dimensions = fitTerminal() ?? { cols: 80, rows: 24 };
        const result = await invoke<TerminalOpenResult>("terminal_open", {
          cols: dimensions.cols,
          rows: dimensions.rows,
          onOutput: channel,
        });
        if (disposed) {
          await invoke("terminal_close", { sessionId: result.session_id }).catch(() => {});
          return;
        }
        sessionRef.current = result.session_id;
        setSessionInfo(result);
        setStatus("open");
        if (active) window.requestAnimationFrame(focusTerminal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
        term.writeln(`\x1b[31m${message}\x1b[0m`);
      }
    };

    const dataDisposable = term.onData((data) => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      void invoke("terminal_write", {
        sessionId,
        data: Array.from(encoder().encode(data)),
      }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      const dimensions = fitTerminal();
      const sessionId = sessionRef.current;
      if (!dimensions || !sessionId) return;
      void invoke("terminal_resize", {
        sessionId,
        cols: dimensions.cols,
        rows: dimensions.rows,
      }).catch(() => {});
    });
    observer.observe(containerRef.current);

    const openTimer = window.setTimeout(() => {
      void openTerminal();
    }, 0);

    return () => {
      disposed = true;
      openingRef.current = false;
      window.clearTimeout(openTimer);
      observer.disconnect();
      dataDisposable.dispose();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      setSessionInfo(null);
      setStatus("idle");
      if (sessionId) {
        void invoke("terminal_close", { sessionId }).catch(() => {});
      }
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [fitTerminal, focusTerminal, hasProject, projectRoot, terminalColorMode, terminalFontFamily, terminalFontSize, theme]);

  if (!hasProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <SquareTerminal className="h-6 w-6 text-[rgb(var(--color-text-secondary))]/40" />
        <div className="text-xs text-[rgb(var(--color-text-secondary))]">Open a workspace to start a terminal.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
        <div className="min-w-0 truncate">
          {status === "opening" ? "Starting terminal..." : sessionInfo?.cwd ?? currentProject?.root}
        </div>
        {status === "open" && sessionInfo && (
          <span className="shrink-0 truncate" title={sessionInfo.shell}>{sessionInfo.shell}</span>
        )}
        {status === "error" && (
          <span className="flex shrink-0 items-center gap-1 text-error" title={error ?? undefined}>
            <AlertTriangle className="h-3 w-3" />
            Terminal failed
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="m-1 min-h-0 flex-1 overflow-hidden rounded-md border border-[rgb(var(--color-border))] p-1 shadow-inner"
        style={{ backgroundColor: theme.background }}
        onMouseDown={focusTerminal}
        onPointerDown={focusTerminal}
      />
    </div>
  );
}
