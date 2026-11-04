// Home screen actions. Each one reuses an existing app capability (open/create a workspace,
// import as a note, create a sketch, queue a chat prompt); none adds a new pipeline.
import { useCallback } from "react";
import { message, open } from "../../dialogs";
import { importIpc, workspaceIpc, type ImportConflict } from "../../ipc/workspace";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../hooks/useSettings";
import { useToastStore } from "../../stores/toastStore";
import { draftFromImportPrompt, noteImportCommand, isOpenProject, noteMention, uniqueSketchTitle } from "../../utils/home";

const DECK_FILTERS = [{ name: "PowerPoint deck", extensions: ["pptx"] }];
const DOCUMENT_FILTERS = [{ name: "Documents", extensions: ["docx", "pdf", "md"] }];
const ATTACH_FILTERS = [{ name: "Decks and documents", extensions: ["pptx", "docx", "pdf", "md"] }];

async function chooseFolder(title: string): Promise<string | null> {
  let defaultPath: string | undefined;
  try {
    defaultPath = (await workspaceIpc.lastParentFolder()) ?? undefined;
  } catch { /* no remembered folder */ }
  const selected = await open({ directory: true, multiple: false, defaultPath, title });
  return typeof selected === "string" ? selected : null;
}

async function chooseFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const selected = await open({ title, multiple: false, filters });
  return typeof selected === "string" ? selected : null;
}

/** Imports a file as a note, asking what to do when the note already exists. Null when cancelled. */
async function importAsNote(filePath: string): Promise<string | null> {
  const command = noteImportCommand(filePath);
  if (!command) throw new Error("CutReady can import .pptx, .docx, .pdf and .md files.");
  try {
    return await importIpc.toNote(command, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("FILE_EXISTS:")) throw err;
    const existing = msg.slice("FILE_EXISTS:".length);
    const answer = await message(
      `"${existing}" already exists in this workspace.\n\nOverwrite will replace the existing import output and its images.`,
      { title: "File Already Exists", buttons: { yes: "Overwrite", no: "Keep Both", cancel: "Cancel" } },
    );
    let conflict: ImportConflict | null = null;
    if (answer === "Overwrite" || answer === "Yes") conflict = "overwrite";
    else if (answer === "Keep Both" || answer === "No") conflict = "rename";
    return conflict ? importIpc.toNote(command, filePath, conflict) : null;
  }
}

function reportError(context: string, err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  console.error(`[home] ${context}:`, text);
  useToastStore.getState().show(`${context}: ${text}`, 6000, "error");
}

export function useHomeActions() {
  const openProject = useAppStore((s) => s.openProject);

  /** Opens `path` unless it is already the open project. True when it ends up open. */
  const ensureProject = useCallback(async (path: string | null): Promise<boolean> => {
    if (!path) return false;
    if (!isOpenProject(useAppStore.getState().currentProject, path)) await openProject(path);
    return isOpenProject(useAppStore.getState().currentProject, path);
  }, [openProject]);

  const openFolder = useCallback(async (stayHome = false): Promise<string | null> => {
    const selected = await chooseFolder("Open workspace folder");
    if (!selected) return null;
    await openProject(selected);
    const app = useAppStore.getState();
    if (stayHome) app.setView("home");
    await app.loadRecentProjects();
    return selected;
  }, [openProject]);

  /** Sends `text` to a fresh chat in `projectPath` with `agentId`, then shows the chat companion. */
  const sendPrompt = useCallback(async (text: string, agentId: string, projectPath: string | null) => {
    const prompt = text.trim();
    if (!prompt || !(await ensureProject(projectPath))) return false;
    if (useChatStore.getState().chatLoading) {
      // A queued prompt would steer the running chat instead of starting a fresh one.
      useToastStore.getState().show("A chat is still running. Stop it or let it finish, then send again.", 6000, "error");
      return false;
    }
    await useSettingsStore.getState().updateSetting("aiSelectedAgent", agentId);
    const chat = useChatStore.getState();
    chat.newChatSession();
    chat.setChatFocusMode(false);
    chat.sendChatPrompt(prompt, { agent: agentId });
    const app = useAppStore.getState();
    if (app.view !== "project") app.setView("project");
    app.setSecondaryPanelVisible(true);
    return true;
  }, [ensureProject]);

  /** Imports a deck or document as a note, opens it, and asks Planner to draft from it. */
  const importAndDraft = useCallback(async (source: "deck" | "document", projectPath: string | null) => {
    try {
      if (!(await ensureProject(projectPath))) return;
      const filePath = await chooseFile(
        source === "deck" ? "Import a deck" : "Draft from a document",
        source === "deck" ? DECK_FILTERS : DOCUMENT_FILTERS,
      );
      if (!filePath) return;
      const notePath = await importAsNote(filePath);
      if (!notePath) return;
      const app = useAppStore.getState();
      await app.loadNotes();
      await app.loadAssets();
      await app.openNote(notePath);
      await sendPrompt(draftFromImportPrompt(notePath, source), "planner", projectPath);
    } catch (err) {
      reportError("Import failed", err);
    }
  }, [ensureProject, sendPrompt]);

  /** Imports a file into `projectPath` and returns a chat mention for it, or null. */
  const attachFile = useCallback(async (projectPath: string | null): Promise<string | null> => {
    try {
      if (!(await ensureProject(projectPath))) return null;
      const filePath = await chooseFile("Attach a deck or document", ATTACH_FILTERS);
      if (!filePath) return null;
      const notePath = await importAsNote(filePath);
      if (!notePath) return null;
      await useAppStore.getState().loadNotes();
      // Opening the project may have left Home; come back so the prompt stays in view.
      useAppStore.getState().setView("home");
      return noteMention(notePath);
    } catch (err) {
      reportError("Attach failed", err);
      return null;
    }
  }, [ensureProject]);

  const startBlankSketch = useCallback(async (projectPath: string | null) => {
    if (!(await ensureProject(projectPath))) return;
    const app = useAppStore.getState();
    await app.createSketch(uniqueSketchTitle(app.sketches.map((s) => s.path)));
  }, [ensureProject]);

  return { ensureProject, openFolder, chooseFolder, sendPrompt, importAndDraft, attachFile, startBlankSketch };
}
