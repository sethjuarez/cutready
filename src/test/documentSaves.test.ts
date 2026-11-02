import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), createCopy: vi.fn() }));
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class {},
}));
vi.mock("../ipc/documents", () => ({ documentsIpc: ipc }));

import {
  conflictStamp,
  INSTALL_SETTLE_MS,
  isDocumentConflict,
  loadDocument,
  refreshOpenDocuments,
  saveDocument,
} from "../services/documentSaves";
import { useAppStore } from "../stores/appStore";
import { documentEntry, resetDocumentVersions } from "../stores/documentVersionStore";
import { useToastStore } from "../stores/toastStore";
import type { ProjectView } from "../types/project";
import type { Sketch } from "../types/sketch";

const ROOT = "D:\\demo";

function sketch(title: string): Sketch {
  return { title, description: "", rows: [], created_at: "", updated_at: "" } as unknown as Sketch;
}

function versioned(document: unknown, version: string, extra: Record<string, unknown> = {}) {
  return { document, content: JSON.stringify(document), version, merged: false, ...extra };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, INSTALL_SETTLE_MS + 20));
const entry = (path = "demo.sk") => documentEntry(ROOT, path);

async function openSketch(document: Sketch, version: string) {
  ipc.read.mockResolvedValueOnce(versioned(document, version));
  await loadDocument<Sketch>("sketch", "demo.sk");
  await settle();
}

beforeEach(() => {
  resetDocumentVersions();
  ipc.read.mockReset();
  ipc.save.mockReset();
  ipc.createCopy.mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue([]);
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({
    currentProject: { root: ROOT, name: "demo" } as unknown as ProjectView,
    openTabs: [{ id: "main:sketch:demo.sk", type: "sketch", path: "demo.sk", title: "Demo" }],
    splitTabs: [],
    activeSketchPath: "demo.sk",
    activeSketch: sketch("v0"),
  });
});

afterEach(() => {
  useAppStore.setState({ currentProject: null, openTabs: [], splitTabs: [], activeSketchPath: null, activeSketch: null });
});

describe("document saves", () => {
  it("sends the loaded base and its version with every save", async () => {
    await openSketch(sketch("v0"), "h0");
    ipc.save.mockResolvedValueOnce(versioned(sketch("v1"), "h1"));

    await saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "v1" });

    expect(ipc.save).toHaveBeenCalledWith("update_sketch_title", {
      relativePath: "demo.sk",
      title: "v1",
      expectedVersion: "h0",
      base: JSON.stringify(sketch("v0")),
    });
    expect(entry()).toMatchObject({ baseVersion: "h1", inFlight: 0, editRevision: 1, savedRevision: 1 });
  });

  it("runs saves of one document one at a time, in order", async () => {
    await openSketch(sketch("v0"), "h0");
    const first = deferred<unknown>();
    ipc.save.mockReturnValueOnce(first.promise).mockResolvedValueOnce(versioned(sketch("v2"), "h2"));

    const one = saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "v1" });
    const two = saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "v2" });
    await Promise.resolve();
    expect(ipc.save).toHaveBeenCalledTimes(1);

    first.resolve(versioned(sketch("v1"), "h1"));
    await Promise.all([one, two]);
    expect(ipc.save).toHaveBeenCalledTimes(2);
    expect(ipc.save.mock.calls[1][1]).toMatchObject({ title: "v2", expectedVersion: "h1" });
  });

  it("keeps the editor's own document as the base after a merged save, and installs the merge only once clean", async () => {
    await openSketch(sketch("v0"), "h0");
    const first = deferred<unknown>();
    const local = sketch("local");
    const merged = sketch("merged");
    ipc.save
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(versioned(merged, "hm2", { merged: true, synced: { content: "local-2", version: "hl2" } }));

    ipc.read.mockResolvedValue(versioned(merged, "hm2"));
    const one = saveDocument("update_sketch", { relativePath: "demo.sk", rows: [] });
    // The user keeps typing while the first save is in flight.
    const two = saveDocument("update_sketch", { relativePath: "demo.sk", rows: [] });
    first.resolve(versioned(merged, "hm1", { merged: true, synced: { content: JSON.stringify(local), version: "hl1" } }));
    await one;
    // The merged document isn't installed under the edit that's still saving.
    expect(useAppStore.getState().activeSketch?.title).toBe("v0");
    await vi.waitFor(() => expect(ipc.save).toHaveBeenCalledTimes(2));
    expect(ipc.save.mock.calls[1][1]).toMatchObject({ expectedVersion: "hl1", base: JSON.stringify(local) });

    await two;
    await vi.waitFor(() => expect(useAppStore.getState().activeSketch?.title).toBe("merged"));
    await settle();
    expect(entry()).toMatchObject({ base: JSON.stringify(merged), baseVersion: "hm2" });
  });

  it("doesn't adopt an installed document as the base when a save starts before it settles", async () => {
    await openSketch(sketch("v0"), "h0");
    ipc.read.mockResolvedValue(versioned(sketch("external"), "hx"));
    await refreshOpenDocuments();
    expect(useAppStore.getState().activeSketch?.title).toBe("external");

    // A save built from what the editor showed before the install.
    ipc.save.mockResolvedValueOnce(versioned(sketch("x"), "hs"));
    await saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "typed" });
    expect(ipc.save.mock.calls[0][1]).toMatchObject({ expectedVersion: "h0" });
  });

  it("writes a conflicting save to one conflict copy, then reloads, then warns", async () => {
    await openSketch(sketch("v0"), "h0");
    const order: string[] = [];
    const stale = deferred<unknown>();
    ipc.save.mockImplementation((_: string, args: Record<string, unknown>) => {
      order.push(`save ${args.relativePath}`);
      if (args.relativePath === "demo.sk") return stale.promise;
      return Promise.resolve(versioned(sketch("copy"), `c${order.length}`));
    });
    ipc.createCopy.mockImplementation((path: string, content: string) => {
      order.push(`copy ${path}`);
      return Promise.resolve({ document: content, content, version: "c0", merged: false });
    });
    ipc.read.mockImplementation(() => {
      order.push("reload");
      return Promise.resolve(versioned(sketch("theirs"), "h9"));
    });
    const show = vi.spyOn(useToastStore.getState(), "show");

    const one = saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "mine" });
    const two = saveDocument("update_sketch", { relativePath: "demo.sk", rows: [] });
    stale.reject({ code: "stale_document", message: "stale" });

    const [first, second] = await Promise.allSettled([one, two]);
    expect(first.status === "rejected" && isDocumentConflict(first.reason)).toBe(true);
    expect(second.status).toBe("fulfilled");
    await vi.waitFor(() => expect(show).toHaveBeenCalled());

    expect(ipc.createCopy).toHaveBeenCalledTimes(1);
    const copyPath = ipc.createCopy.mock.calls[0][0] as string;
    expect(copyPath).toMatch(/^demo \(conflict \d{8}-\d{6}\)\.sk$/);
    expect(ipc.createCopy.mock.calls[0][1]).toBe(JSON.stringify(sketch("v0")));
    expect(order).toEqual([
      "save demo.sk",
      `copy ${copyPath}`,
      `save ${copyPath}`,
      `save ${copyPath}`,
      "reload",
    ]);
    expect(show).toHaveBeenCalledWith(expect.stringContaining(copyPath), 10000, "warning");
    expect(useAppStore.getState().activeSketch?.title).toBe("theirs");

    // After the reload settles, saves go to the document again, from the reloaded base.
    await settle();
    ipc.save.mockImplementation(() => Promise.resolve(versioned(sketch("next"), "h10")));
    await saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "next" });
    expect(ipc.save).toHaveBeenLastCalledWith("update_sketch_title", expect.objectContaining({ relativePath: "demo.sk", expectedVersion: "h9" }));
    expect(ipc.createCopy).toHaveBeenCalledTimes(1);
  });

  it("numbers the conflict copy when the name is taken", async () => {
    await openSketch(sketch("v0"), "h0");
    ipc.save.mockImplementation((_: string, args: Record<string, unknown>) =>
      args.relativePath === "demo.sk"
        ? Promise.reject({ code: "stale_document" })
        : Promise.resolve(versioned(sketch("copy"), "c1")));
    ipc.createCopy
      .mockRejectedValueOnce({ code: "file_exists" })
      .mockResolvedValueOnce({ document: "", content: "", version: "c0", merged: false });
    ipc.read.mockResolvedValue(versioned(sketch("theirs"), "h9"));

    await expect(saveDocument("update_sketch_title", { relativePath: "demo.sk", title: "mine" })).rejects.toSatisfy(isDocumentConflict);
    expect(ipc.createCopy.mock.calls[1][0]).toMatch(/^demo \(conflict \d{8}-\d{6}-1\)\.sk$/);
  });

  it("refreshes clean documents that changed on disk and skips ones with edits in flight", async () => {
    useAppStore.setState({
      openTabs: [
        { id: "main:sketch:demo.sk", type: "sketch", path: "demo.sk", title: "Demo" },
        { id: "main:note:busy.md", type: "note", path: "busy.md", title: "Busy" },
      ],
    });
    await openSketch(sketch("v0"), "h0");
    ipc.read.mockResolvedValueOnce({ document: "n0", content: "n0", version: "n0", merged: false });
    await loadDocument<string>("note", "busy.md");
    await settle();
    const pending = deferred<unknown>();
    ipc.save.mockReturnValueOnce(pending.promise);
    const busy = saveDocument("update_note", { relativePath: "busy.md", content: "typing" });

    ipc.read.mockReset();
    ipc.read.mockImplementation((kind: string) =>
      Promise.resolve(kind === "sketch" ? versioned(sketch("external"), "h1") : { document: "x", content: "x", version: "nx", merged: false }));
    await refreshOpenDocuments();

    expect(ipc.read).toHaveBeenCalledTimes(1);
    expect(ipc.read).toHaveBeenCalledWith("sketch", "demo.sk");
    expect(useAppStore.getState().activeSketch?.title).toBe("external");
    pending.resolve({ document: "typing", content: "typing", version: "n1", merged: false });
    await busy;
  });

  it("leaves documents unchanged on disk alone", async () => {
    await openSketch(sketch("v0"), "h0");
    const shown = useAppStore.getState().activeSketch;
    ipc.read.mockResolvedValue(versioned(sketch("v0"), "h0"));
    await refreshOpenDocuments();
    expect(useAppStore.getState().activeSketch).toBe(shown);
  });

  it("stamps conflict copies in filesystem-safe UTC", () => {
    expect(conflictStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("20260102-030405");
  });
});
