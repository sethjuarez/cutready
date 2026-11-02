import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { InlineDescriptionEditor, type DraftFlushRef } from "../components/InlineDescriptionEditor";
import { MetadataEditor } from "../components/MetadataEditor";

afterEach(cleanup);

const draftRef = () => {
  const ref = createRef() as DraftFlushRef;
  ref.current = null;
  return ref;
};

describe("editor draft refs", () => {
  it("exposes a pending metadata edit until it is flushed", async () => {
    const onChange = vi.fn(() => Promise.resolve());
    const ref = draftRef();
    render(<MetadataEditor metadata={{ fields: { owner: "a" } }} onChange={onChange} draftRef={ref} />);

    fireEvent.change(screen.getByLabelText("Metadata value for owner"), { target: { value: "b" } });
    expect(ref.current).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => ref.current!());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ fields: { owner: "b" } }, true);
    expect(ref.current).toBeNull();

    // The debounce was cancelled, so the edit isn't saved a second time.
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("exposes a pending description draft and keeps it when the flush fails", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const ref = draftRef();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<InlineDescriptionEditor value="" placeholder="" label="Description" onDraftChange={() => {}} onSave={onSave} draftRef={ref} />);

    fireEvent.click(screen.getByRole("button", { name: "Description" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "typed" } });
    expect(ref.current).not.toBeNull();

    await act(async () => expect(ref.current!()).rejects.toThrow());
    expect(ref.current).not.toBeNull();

    await act(async () => ref.current!());
    expect(onSave).toHaveBeenLastCalledWith("typed", true);
    expect(ref.current).toBeNull();
  });
});