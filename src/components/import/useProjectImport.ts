// Runs one project import: pick or receive files, route each by extension, resolve name
// conflicts, follow video progress, then refresh the documents and open what was imported.
import { useCallback, useEffect, useRef, useState } from "react";
import { importIpc, type ImportConflict, type VideoImportPlanningContext, type VideoImportProgress } from "../../ipc/workspace";
import { commandErrorText } from "../../services/commandErrors";
import { useAppStore } from "../../stores/appStore";
import type { PendingImport } from "../../stores/importStore";
import { useToastStore } from "../../stores/toastStore";
import { clipboardMarkdown, createUniqueNote } from "./clipboardNote";
import { containsVideo, importPickerOptions, importTarget, noteStem, partitionImportable, skippedFilesMessage } from "./importRouting";
import { useVideoImportLlmConfig } from "./useVideoImportLlmConfig";
import { useVideoImportContext } from "./useVideoImportContext";

const VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX = "VIDEO_IMPORT_MISSING_TRANSCRIPT:";
const VIDEO_IMPORT_DURATION_LIMIT_PREFIX = "VIDEO_IMPORT_DURATION_LIMIT:";
const VIDEO_STEPS = 7;

/** Thrown when the project an import was requested for is no longer the open one. */
export class ProjectChangedError extends Error {
  constructor() {
    super("Import stopped because the project changed.");
  }
}

/** Throws ProjectChangedError unless `projectRoot` is still the open project. */
export function projectGuard(projectRoot: string) {
  return () => {
    if (useAppStore.getState().currentProject?.root !== projectRoot) throw new ProjectChangedError();
  };
}

type Guard = () => void;

const isProtectedDocumentError = (message: string) =>
  message.includes("DRM-protected") || message.includes("protected or encrypted");

export function useProjectImport() {
  const showToast = useToastStore((s) => s.show);
  const buildLlmConfig = useVideoImportLlmConfig();
  const videoContext = useVideoImportContext();
  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const keepProgressRef = useRef(false);
  const [drmConfirm, setDrmConfirm] = useState<{ resolve: (ok: boolean) => void } | null>(null);

  const confirmClipboardFallback = useCallback(
    () => new Promise<boolean>((resolve) => setDrmConfirm({ resolve })),
    [],
  );
  const resolveDrmConfirm = useCallback((ok: boolean) => {
    setDrmConfirm((current) => {
      current?.resolve(ok);
      return null;
    });
  }, []);

  // A project switch cancels any in-app dialog an import is waiting on, so the run unwinds and
  // the guard stops it. (Native dialogs can't be closed; the guard runs once they return.)
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const cancelContext = videoContext.cancel;
  useEffect(() => {
    cancelContext();
    resolveDrmConfirm(false);
  }, [projectRoot, cancelContext, resolveDrmConfirm]);

  const showFailure = useCallback((message: string) => {
    keepProgressRef.current = true;
    setProgress({ phase: "failed", current: 0, total: 1, message });
  }, []);

  /** Runs an import; on a name clash asks to overwrite or keep both. Resolves null if cancelled or reported. */
  const withConflict = useCallback(async <T,>(ensureOpen: Guard, run: (conflict?: ImportConflict) => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      const msg = commandErrorText(err);
      if (msg.startsWith("FILE_EXISTS:")) {
        const existing = msg.slice("FILE_EXISTS:".length);
        const { message } = await import("../../dialogs");
        const choice = await message(
          `"${existing}" already exists in this workspace.\n\nOverwrite will replace the existing import output and its images.`,
          {
            title: existing.includes(" and ") ? "Files Already Exist" : "File Already Exists",
            buttons: { yes: "Overwrite", no: "Keep Both", cancel: "Cancel" },
          },
        );
        ensureOpen();
        // Custom buttons resolve to their label (the plugin returns "Yes"/"No" only for default buttons).
        if (choice === "Overwrite" || choice === "Yes") return run("overwrite");
        if (choice === "Keep Both" || choice === "No") return run("rename");
        return null;
      }
      if (msg.startsWith(VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX)) {
        showFailure(msg.slice(VIDEO_IMPORT_MISSING_TRANSCRIPT_PREFIX.length));
        return null;
      }
      if (msg.startsWith(VIDEO_IMPORT_DURATION_LIMIT_PREFIX)) {
        showFailure(msg.slice(VIDEO_IMPORT_DURATION_LIMIT_PREFIX.length));
        return null;
      }
      throw err;
    }
  }, [showFailure]);

  const pasteNote = useCallback(async (stem: string, ensureOpen: Guard) => {
    let markdown = "";
    ensureOpen();
    try {
      markdown = await clipboardMarkdown();
    } catch {
      showToast("Couldn't read the clipboard. Copy the text again and retry.", 5000, "warning");
      return null;
    }
    if (!markdown) {
      showToast("The clipboard is empty. Copy some text first.", 5000, "warning");
      return null;
    }
    ensureOpen();
    return createUniqueNote(stem, markdown);
  }, [showToast]);

  const pickFiles = useCallback(async (kind: "files" | "video") => {
    const { open } = await import("../../dialogs");
    const selected = await open({ ...importPickerOptions[kind], multiple: true });
    if (!selected) return [];
    return (Array.isArray(selected) ? selected : [selected]).map(String);
  }, []);

  const importFiles = useCallback(async (paths: string[], ensureOpen: Guard) => {
    const planningContext: VideoImportPlanningContext | null = containsVideo(paths) ? await videoContext.request() : null;
    ensureOpen();
    if (containsVideo(paths) && planningContext === null) return;
    const llmConfig = containsVideo(paths) ? await buildLlmConfig() : null;
    let openNote = "";
    let openSketch = "";

    for (const filePath of paths) {
      ensureOpen();
      const target = importTarget(filePath);
      if (!target) continue;
      try {
        if (target.kind === "sketch") {
          await withConflict(ensureOpen, (conflict) => importIpc.sketch(filePath, conflict));
        } else if (target.kind === "storyboard") {
          await withConflict(ensureOpen, (conflict) => importIpc.storyboard(filePath, conflict));
        } else if (target.kind === "note") {
          const note = await withConflict(ensureOpen, (conflict) => importIpc.toNote(target.command, filePath, conflict));
          if (note) openNote = note;
        } else {
          setProgress({ phase: "preparing", current: 0, total: VIDEO_STEPS, message: "Preparing demo video import" });
          const options = {
            ...(llmConfig ? { llmConfig } : {}),
            ...(planningContext && (planningContext.text || planningContext.references.length) ? { planningContext } : {}),
          };
          const result = await withConflict(ensureOpen, (conflict) => importIpc.videoWithProgress(filePath, options, setProgress, conflict));
          if (result) {
            openSketch = result.sketch_path;
            if (result.note_path) openNote = result.note_path;
            setProgress({
              phase: "complete",
              current: VIDEO_STEPS,
              total: VIDEO_STEPS,
              message: result.llm_refined ? "Analyzer-assisted video import complete" : "Heuristic video import complete",
            });
            showToast(
              result.llm_refined
                ? `Imported analyzer-assisted video sketch with ${result.row_count} rows and a summary note`
                : `Imported video sketch with ${result.row_count} heuristic scenes and a summary note`,
              4000,
              "success",
            );
          }
        }
      } catch (err) {
        if (err instanceof ProjectChangedError) throw err;
        const msg = commandErrorText(err);
        console.error("[import] Import failed:", msg);
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        if (isProtectedDocumentError(msg)) {
          if (await confirmClipboardFallback()) {
            const note = await pasteNote(noteStem(name, "imported-clipboard"), ensureOpen);
            if (note) openNote = note;
          }
        } else {
          showToast(`Couldn't import ${name}: ${msg}`, 6000, "error");
        }
      }
    }
    return { openNote, openSketch };
  }, [buildLlmConfig, confirmClipboardFallback, pasteNote, showToast, videoContext, withConflict]);

  /** Runs `request`; resolves once the import has finished, been cancelled, or failed. */
  const run = useCallback(async (request: PendingImport) => {
    const ensureOpen = projectGuard(request.projectRoot);
    try {
      let opened: { openNote: string; openSketch: string } | undefined;
      if (request.kind === "clipboard") {
        const note = await pasteNote("pasted-note", ensureOpen);
        opened = { openNote: note ?? "", openSketch: "" };
      } else {
        const chosen = request.kind === "paths" ? request.paths : await pickFiles(request.kind);
        const { supported, unsupported } = partitionImportable(chosen);
        if (unsupported.length) showToast(skippedFilesMessage(unsupported), 5000, "warning");
        ensureOpen();
        if (!supported.length) return;
        opened = await importFiles(supported, ensureOpen);
      }
      if (!opened) return;
      // Recheck before each step so nothing refreshes or opens in a project opened meanwhile.
      const store = useAppStore.getState();
      for (const step of [store.loadSketches, store.loadStoryboards, store.loadNotes, store.loadAssets]) {
        ensureOpen();
        await step();
      }
      ensureOpen();
      if (opened.openSketch) await store.openSketch(opened.openSketch);
      ensureOpen();
      if (opened.openNote) await store.openNote(opened.openNote);
    } catch (err) {
      if (err instanceof ProjectChangedError) showToast(err.message, 5000, "warning");
      else showToast(`Import failed: ${commandErrorText(err)}`, 6000, "error");
    } finally {
      if (keepProgressRef.current) keepProgressRef.current = false;
      else window.setTimeout(() => setProgress(null), 700);
    }
  }, [importFiles, pasteNote, pickFiles, showToast]);

  return {
    run,
    progress,
    closeProgress: () => setProgress(null),
    videoContext,
    drmConfirmOpen: drmConfirm !== null,
    resolveDrmConfirm,
  };
}
