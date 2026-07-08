import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { InlineDescriptionEditor } from "../components/InlineDescriptionEditor";

function Harness({
  initialValue = "Original **description**",
  onSave,
}: {
  initialValue?: string;
  onSave: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <InlineDescriptionEditor
      value={value}
      placeholder="Add a description..."
      previewClassName="prose-desc"
      textareaClassName="editor"
      onDraftChange={setValue}
      onSave={onSave}
    />
  );
}

describe("InlineDescriptionEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("saves while typing and exits when clicking outside", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<Harness onSave={onSave} />);

    fireEvent.click(screen.getByText("description"));
    const editor = screen.getByDisplayValue("Original **description**");
    fireEvent.change(editor, { target: { value: "Updated description" } });

    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith("Updated description");

    await act(async () => {
      fireEvent.blur(editor);
      await Promise.resolve();
    });

    expect(screen.queryByDisplayValue("Updated description")).not.toBeInTheDocument();
    expect(screen.getByText("Updated description")).toBeInTheDocument();
  });

  it("exits edit mode with Escape without discarding markdown", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<Harness onSave={onSave} />);

    fireEvent.click(screen.getByText("description"));
    const editor = screen.getByDisplayValue("Original **description**");
    fireEvent.change(editor, { target: { value: "Draft **kept**" } });
    fireEvent.keyDown(editor, { key: "Escape" });

    expect(screen.queryByDisplayValue("Draft **kept**")).not.toBeInTheDocument();
    expect(screen.getByText("kept")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith("Draft **kept**");
  });

  it("saves and exits with Ctrl+Enter", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<Harness onSave={onSave} />);

    fireEvent.click(screen.getByText("description"));
    const editor = screen.getByDisplayValue("Original **description**");
    fireEvent.change(editor, { target: { value: "Committed from keyboard" } });
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith("Committed from keyboard");
    expect(screen.queryByDisplayValue("Committed from keyboard")).not.toBeInTheDocument();
    expect(screen.getByText("Committed from keyboard")).toBeInTheDocument();
  });

  it("renders markdown and soft line breaks in preview mode", () => {
    const { container } = render(
      <Harness
        initialValue={"First line\nSecond **bold** line\n- item"}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("br")).toBeInTheDocument();
    expect(screen.getByText("item")).toBeInTheDocument();
    expect(container.querySelector("li")?.textContent).toBe("item");
  });

  it("continues markdown lists like sketch cells", () => {
    render(<Harness initialValue="- first" onSave={vi.fn()} />);

    fireEvent.click(screen.getByText("first"));
    const editor = screen.getByDisplayValue("- first") as HTMLTextAreaElement;
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(editor.value).toBe("- first\n- ");
  });
});
