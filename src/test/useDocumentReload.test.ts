import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("../services/documentSaves", () => ({ loadDocument: (...args: unknown[]) => load(...args) }));

import { useDocumentReload } from "../hooks/useDocumentReload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let pending = false;
const apply = vi.fn();

function renderEditor(path = "demo.sk") {
  return renderHook(() =>
    useDocumentReload<{ title: string }>({
      kind: "sketch",
      path,
      events: ["cutready:sketch-saved"],
      hasPending: () => pending,
      apply,
    }),
  );
}

const refreshed = (path: string, title: string) =>
  window.dispatchEvent(
    new CustomEvent("cutready:document-refreshed", {
      detail: { path, document: { title }, content: title, version: title },
      cancelable: true,
    }),
  );

beforeEach(() => {
  pending = false;
  apply.mockReset();
  load.mockReset();
});

describe("useDocumentReload", () => {
  it("shows a refreshed document at once, without reading it again", () => {
    renderEditor();
    expect(refreshed("demo.sk", "disk")).toBe(true);
    expect(apply).toHaveBeenCalledWith({ title: "disk" });
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a refresh while edits are pending, and ignores other documents", () => {
    renderEditor();
    pending = true;
    expect(refreshed("demo.sk", "disk")).toBe(false);
    expect(refreshed("other.sk", "disk")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a delayed read when typing happens after the reload event", async () => {
    const read = deferred<{ title: string }>();
    load.mockReturnValueOnce(read.promise);
    const { result } = renderEditor();

    window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    expect(load).toHaveBeenCalledWith("sketch", "demo.sk");
    result.current();
    await act(async () => read.resolve({ title: "older" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a delayed read when edits are pending by the time it resolves", async () => {
    const read = deferred<{ title: string }>();
    load.mockReturnValueOnce(read.promise);
    renderEditor();

    window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    pending = true;
    await act(async () => read.resolve({ title: "older" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a delayed read that a refresh overtook", async () => {
    const read = deferred<{ title: string }>();
    load.mockReturnValueOnce(read.promise);
    renderEditor();

    window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    refreshed("demo.sk", "disk");
    await act(async () => read.resolve({ title: "older" }));
    expect(apply.mock.calls).toEqual([[{ title: "disk" }]]);
  });

  it("shows a delayed read when nothing was typed meanwhile", async () => {
    const read = deferred<{ title: string }>();
    load.mockReturnValueOnce(read.promise);
    renderEditor();

    window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    await act(async () => read.resolve({ title: "saved" }));
    expect(apply).toHaveBeenCalledWith({ title: "saved" });
  });
});
