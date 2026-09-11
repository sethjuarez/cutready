import { useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { Channel, invoke, listen } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import {
  normalizeTerminalColorMode,
  resolveTerminalTheme,
} from "../theme/terminalThemes";
import { useTerminalStore, type TerminalRecord } from "../stores/terminalStore";

type TerminalOpenResult = {
  session_id: string;
  cwd: string;
  shell: string;
};

type TerminalExitedEvent = {
  session_id: string;
};

type TerminalOutput = number[] | ArrayBuffer | Uint8Array;

type RuntimeTerminal = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  sessionId: string | null;
  dataDisposable: { dispose: () => void };
  disposed: boolean;
};

const terminalRuntimes = new Map<string, RuntimeTerminal>();
let nextTerminalIndex = 1;

function readThemeColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  return raw.startsWith("#") || raw.startsWith("rgb") ? raw : `rgb(${raw})`;
}

function terminalId() {
  return `terminal-${Date.now().toString(36)}-${nextTerminalIndex++}`;
}

function encoder() {
  return new TextEncoder();
}

function outputBytes(data: TerminalOutput) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function dimensions(runtime: RuntimeTerminal) {
  if (runtime.host.clientWidth === 0 || runtime.host.clientHeight === 0)
    return null;
  runtime.fit.fit();
  const safeCols = Math.max(2, runtime.term.cols - 3);
  const safeRows = Math.max(2, runtime.term.rows - 1);
  if (safeCols !== runtime.term.cols || safeRows !== runtime.term.rows) {
    runtime.term.resize(safeCols, safeRows);
  }
  return { cols: runtime.term.cols, rows: runtime.term.rows };
}

async function closeRuntime(id: string) {
  const runtime = terminalRuntimes.get(id);
  if (!runtime) return;
  terminalRuntimes.delete(id);
  runtime.disposed = true;
  runtime.dataDisposable.dispose();
  runtime.host.remove();
  const sessionId = runtime.sessionId;
  runtime.sessionId = null;
  if (sessionId) {
    await invoke("terminal_close", { sessionId }).catch(() => {});
  }
  runtime.term.dispose();
}

export function TerminalPanel({ active }: { active: boolean }) {
  const currentProject = useAppStore((state) => state.currentProject);
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const projectRootRef = useRef<string | null>(null);
  const autoOpenedRootRef = useRef<string | null>(null);
  const openingTerminalIdsRef = useRef(new Set<string>());
  const terminals = useTerminalStore((state) => state.terminals);
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const createTerminalRecord = useTerminalStore(
    (state) => state.createTerminalRecord,
  );
  const updateTerminal = useTerminalStore((state) => state.updateTerminal);
  const closeTerminalRecord = useTerminalStore(
    (state) => state.closeTerminalRecord,
  );
  const setActiveTerminal = useTerminalStore(
    (state) => state.setActiveTerminal,
  );
  const resetTerminals = useTerminalStore((state) => state.resetTerminals);

  const hasProject = Boolean(currentProject);
  const projectRoot = currentProject?.root ?? null;
  const terminalFontFamily =
    settings.displayTerminalFontFamily ||
    '"Cascadia Code", Consolas, monospace';
  const terminalFontSize = settings.displayTerminalFontSize || 12;
  const terminalColorMode = normalizeTerminalColorMode(
    settings.displayTerminalColorMode,
  );
  const theme = useMemo(
    () =>
      resolveTerminalTheme(
        terminalColorMode,
        settings.displayTerminalCustomTheme,
        readThemeColor,
      ),
    [settings.displayTerminalCustomTheme, terminalColorMode],
  );
  const activeRecord =
    terminals.find((terminal) => terminal.id === activeTerminalId) ?? null;

  const focusTerminal = useCallback(
    (id = activeTerminalId) => {
      const runtime = id ? terminalRuntimes.get(id) : null;
      runtime?.term.focus();
      runtime?.host
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus({ preventScroll: true });
    },
    [activeTerminalId],
  );

  const syncSize = useCallback(
    (id = activeTerminalId) => {
      if (!id) return null;
      const runtime = terminalRuntimes.get(id);
      if (!runtime) return null;
      const nextDimensions = dimensions(runtime);
      if (!nextDimensions || !runtime.sessionId) return nextDimensions;
      void invoke("terminal_resize", {
        sessionId: runtime.sessionId,
        cols: nextDimensions.cols,
        rows: nextDimensions.rows,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        updateTerminal(id, {
          status: "exited",
          error: message,
          sessionId: null,
        });
        runtime.sessionId = null;
      });
      return nextDimensions;
    },
    [activeTerminalId, updateTerminal],
  );

  const openTerminal = useCallback(
    async (restartId?: string) => {
      if (!hasProject) return;
      const id = restartId ?? terminalId();
      if (openingTerminalIdsRef.current.has(id)) return;
      openingTerminalIdsRef.current.add(id);
      const title = restartId
        ? (terminals.find((terminal) => terminal.id === restartId)?.title ??
          `Terminal ${nextTerminalIndex}`)
        : `Terminal ${nextTerminalIndex - 1}`;

      if (!restartId) {
        const record: TerminalRecord = {
          id,
          sessionId: null,
          title,
          cwd: projectRoot,
          shell: null,
          status: "opening",
          error: null,
        };
        createTerminalRecord(record);
      } else {
        await closeRuntime(id);
        updateTerminal(id, { sessionId: null, status: "opening", error: null });
        setActiveTerminal(id);
      }

      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: terminalFontFamily,
        fontSize: terminalFontSize,
        letterSpacing: 0,
        scrollback: 10_000,
        theme,
      });
      const fit = new FitAddon();
      const host = document.createElement("div");
      host.className = "h-full w-full";
      host.dataset.terminalId = id;
      term.loadAddon(fit);
      if (viewportRef.current) {
        viewportRef.current.replaceChildren(host);
      }
      term.open(host);

      const runtime: RuntimeTerminal = {
        term,
        fit,
        host,
        sessionId: null,
        dataDisposable: { dispose: () => {} },
        disposed: false,
      };
      terminalRuntimes.set(id, runtime);

      const channel = new Channel<TerminalOutput>();
      channel.onmessage = (data) => {
        if (!runtime.disposed) term.write(outputBytes(data));
      };

      runtime.dataDisposable = term.onData((data) => {
        if (!runtime.sessionId) return;
        void invoke("terminal_write", {
          sessionId: runtime.sessionId,
          data: Array.from(encoder().encode(data)),
        }).catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          updateTerminal(id, {
            status: "exited",
            error: message,
            sessionId: null,
          });
          runtime.sessionId = null;
        });
      });

      try {
        const initialDimensions = dimensions(runtime) ?? { cols: 80, rows: 24 };
        const result = await invoke<TerminalOpenResult>("terminal_open", {
          cols: initialDimensions.cols,
          rows: initialDimensions.rows,
          onOutput: channel,
        });
        if (runtime.disposed) {
          updateTerminal(id, { status: "exited", sessionId: null });
          await invoke("terminal_close", {
            sessionId: result.session_id,
          }).catch(() => {});
          return;
        }
        runtime.sessionId = result.session_id;
        updateTerminal(id, {
          sessionId: result.session_id,
          cwd: result.cwd,
          shell: result.shell,
          status: "open",
          error: null,
        });
        window.requestAnimationFrame(() => {
          syncSize(id);
          focusTerminal(id);
        });
      } catch (err) {
        if (runtime.disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        updateTerminal(id, { status: "error", error: message });
        term.writeln(`\x1b[31m${message}\x1b[0m`);
      } finally {
        openingTerminalIdsRef.current.delete(id);
      }
    },
    [
      createTerminalRecord,
      focusTerminal,
      hasProject,
      projectRoot,
      setActiveTerminal,
      terminalFontFamily,
      terminalFontSize,
      terminals,
      theme,
      updateTerminal,
      syncSize,
    ],
  );

  useEffect(() => {
    if (!hasProject) {
      void Promise.all(
        Array.from(terminalRuntimes.keys()).map(closeRuntime),
      ).finally(resetTerminals);
    }
  }, [hasProject, resetTerminals]);

  useEffect(() => {
    if (projectRootRef.current === projectRoot) return;
    const previousRoot = projectRootRef.current;
    projectRootRef.current = projectRoot;
    autoOpenedRootRef.current = null;
    if (!previousRoot) return;
    void Promise.all(
      Array.from(terminalRuntimes.keys()).map(closeRuntime),
    ).finally(resetTerminals);
  }, [projectRoot, resetTerminals]);

  useEffect(() => {
    if (
      hasProject &&
      projectRoot &&
      terminals.length === 0 &&
      autoOpenedRootRef.current !== projectRoot
    ) {
      autoOpenedRootRef.current = projectRoot;
      void openTerminal();
    }
  }, [hasProject, openTerminal, projectRoot, terminals.length]);

  useEffect(() => {
    for (const runtime of terminalRuntimes.values()) {
      runtime.term.options.fontFamily = terminalFontFamily;
      runtime.term.options.fontSize = terminalFontSize;
      runtime.term.options.letterSpacing = 0;
      runtime.term.options.theme = theme;
      syncSize(runtime.host.dataset.terminalId);
    }
  }, [syncSize, terminalFontFamily, terminalFontSize, theme]);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container || !activeTerminalId) return;
    const runtime = terminalRuntimes.get(activeTerminalId);
    if (!runtime) return;
    if (runtime.host.parentElement !== container) {
      container.replaceChildren(runtime.host);
    }
    window.requestAnimationFrame(() => {
      syncSize(activeTerminalId);
      if (active) focusTerminal(activeTerminalId);
    });
  }, [active, activeTerminalId, focusTerminal, syncSize]);

  useEffect(() => {
    if (!active) return;
    window.requestAnimationFrame(() => {
      syncSize();
      focusTerminal();
    });
  }, [active, focusTerminal, syncSize]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      syncSize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncSize]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<TerminalExitedEvent>("terminal-exited", (event) => {
      const sessionId = event.payload.session_id;
      for (const [id, runtime] of terminalRuntimes) {
        if (runtime.sessionId !== sessionId) continue;
        runtime.sessionId = null;
        updateTerminal(id, { status: "exited", sessionId: null, error: null });
        break;
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [updateTerminal]);

  const closeTerminal = useCallback(
    async (id: string) => {
      closeTerminalRecord(id);
      await closeRuntime(id);
    },
    [closeTerminalRecord],
  );

  if (!hasProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <SquareTerminal className="h-6 w-6 text-[rgb(var(--color-text-secondary))]/40" />
        <div className="text-xs text-[rgb(var(--color-text-secondary))]">
          Open a workspace to start a terminal.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[rgb(var(--color-border))] px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              className={`group flex max-w-48 shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors ${
                terminal.id === activeTerminalId
                  ? "border-[rgb(var(--color-accent))]/50 bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text))]"
                  : "border-transparent text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
              }`}
              onClick={() => setActiveTerminal(terminal.id)}
              title={`${terminal.title}${terminal.shell ? ` - ${terminal.shell}` : ""}`}
            >
              {terminal.status === "error" ? (
                <AlertTriangle className="h-3 w-3 text-error" />
              ) : (
                <SquareTerminal className="h-3 w-3" />
              )}
              <span className="truncate">{terminal.title}</span>
              {terminal.status === "exited" && (
                <span className="text-[rgb(var(--color-warning))]">exited</span>
              )}
              <span
                role="button"
                tabIndex={0}
                className="rounded p-0.5 opacity-60 hover:bg-[rgb(var(--color-surface))] hover:opacity-100"
                title={`Close ${terminal.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTerminal(terminal.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  void closeTerminal(terminal.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rounded-md border border-[rgb(var(--color-border))] p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          title="New terminal"
          onClick={() => void openTerminal()}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--color-border))] px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
        <div className="min-w-0 truncate">
          {activeRecord?.status === "opening"
            ? "Starting terminal..."
            : (activeRecord?.cwd ?? projectRoot)}
        </div>
        {activeRecord?.status === "open" && activeRecord.shell && (
          <span className="shrink-0 truncate" title={activeRecord.shell}>
            {activeRecord.shell}
          </span>
        )}
        {(activeRecord?.status === "error" ||
          activeRecord?.status === "exited") && (
          <span
            className="flex shrink-0 items-center gap-1 text-error"
            title={activeRecord.error ?? undefined}
          >
            <AlertTriangle className="h-3 w-3" />
            {activeRecord.status === "error"
              ? "Terminal failed"
              : "Terminal exited"}
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="terminal-xterm-host relative m-1 min-h-0 flex-1 overflow-hidden rounded-md border border-[rgb(var(--color-border))] p-1 shadow-inner"
        style={{ backgroundColor: theme.background }}
        onMouseDown={() => focusTerminal()}
        onPointerDown={() => focusTerminal()}
      >
        <div ref={viewportRef} className="h-full w-full" />
        {(!activeRecord ||
          activeRecord.status === "exited" ||
          activeRecord.status === "error") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgb(var(--color-surface))]/80 backdrop-blur-sm">
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs text-[rgb(var(--color-text))] shadow-sm transition-colors hover:border-[rgb(var(--color-accent))]/50"
              onClick={() =>
                activeRecord
                  ? void openTerminal(activeRecord.id)
                  : void openTerminal()
              }
            >
              <RotateCw className="h-4 w-4" />
              {activeRecord ? "Restart terminal" : "New terminal"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
