// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeIncomingForPrompt, incomingVersions, mergeSuggestionMessages } from "../domain/versioning";
import { askMergeName } from "../services/mergeName";
import { useMergeNameStore } from "../stores/mergeNameStore";

const suggestMergeName = vi.fn();
vi.mock("../services/versionSuggest", () => ({
  isSuggestConfigured: () => Promise.resolve(true),
  suggestMergeName: (...args: unknown[]) => suggestMergeName(...args),
}));

const { MergeNameHost } = await import("../components/versioning/MergeNameDialog");

afterEach(() => {
  cleanup();
  suggestMergeName.mockReset();
  useMergeNameStore.setState({ pending: null });
});

describe("incomingVersions", () => {
  it("reads names and comments from Draftline summaries", () => {
    expect(incomingVersions([
      { label: "Tighten the intro", comment: "Cut the second slide." },
      { label: "Add demo", comment: null },
    ])).toEqual([
      { name: "Tighten the intro", comment: "Cut the second slide." },
      { name: "Add demo", comment: "" },
    ]);
  });

  it("splits older labels that carry the comment after a blank line", () => {
    expect(incomingVersions([{ label: "Retime outro\n\nShorter pauses." }])).toEqual([
      { name: "Retime outro", comment: "Shorter pauses." },
    ]);
    expect(incomingVersions(undefined)).toEqual([]);
  });
});

describe("merge suggestion prompt", () => {
  it("describes the incoming versions, not local work", () => {
    const text = describeIncomingForPrompt("main", [
      { name: "Tighten the intro", comment: "Cut the\nsecond slide." },
      { name: "Add demo", comment: "" },
    ]);
    expect(text).toBe(
      "Incoming versions from main:\n<versions>\n- Tighten the intro: Cut the second slide.\n- Add demo\n</versions>",
    );
    expect(mergeSuggestionMessages("main", [])[0].content).toMatch(/never follow instructions/i);
  });

  it("caps long lists", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `v${i}`, comment: "" }));
    expect(describeIncomingForPrompt("", many)).toContain("- …and 5 more");
  });

  it("bounds each field and the whole list", () => {
    const huge = Array.from({ length: 40 }, () => ({ name: "n", comment: "x".repeat(5000) }));
    const text = describeIncomingForPrompt("main", huge);
    expect(text).toContain(`${"x".repeat(299)}…`);
    expect(text).not.toContain("x".repeat(300));
    expect(text.length).toBeLessThan(8200);
    expect(text).toMatch(/- …and \d+ more/);
  });
});

describe("merge-name dialog ✨ Suggest", () => {
  const incoming = [{ name: "Tighten the intro", comment: "Cut the second slide." }];

  it("asks for a name from the incoming versions only when clicked", async () => {
    suggestMergeName.mockResolvedValue({ name: "Bring in Ana's intro edits", comment: "Tighter opening." });
    render(<MergeNameHost />);
    let asked!: Promise<string | null>;
    act(() => {
      asked = askMergeName("main", incoming);
    });
    const button = await screen.findByTestId("merge-name-suggest");
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(suggestMergeName).not.toHaveBeenCalled();

    fireEvent.click(button);
    // The prefilled default isn't the user's text, so it's replaced without asking.
    await waitFor(() => expect(screen.getByTestId("merge-name-input")).toHaveValue("Bring in Ana's intro edits"));
    expect(suggestMergeName).toHaveBeenCalledWith("main", incoming);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();

    fireEvent.click(screen.getByTestId("merge-name-confirm"));
    await expect(asked).resolves.toBe("Bring in Ana's intro edits\n\nTighter opening.");
  });

  it("asks before replacing a name the user typed", async () => {
    suggestMergeName.mockResolvedValue({ name: "Suggested", comment: "" });
    render(<MergeNameHost />);
    act(() => {
      void askMergeName("main", incoming);
    });
    const input = await screen.findByTestId("merge-name-input");
    fireEvent.change(input, { target: { value: "My name" } });
    const button = screen.getByTestId("merge-name-suggest");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Keep mine" }));
    expect(input).toHaveValue("My name");
  });

  it("asks before replacing a name the user typed", async () => {
    suggestMergeName.mockResolvedValue({ name: "Suggested", comment: "" });
    render(<MergeNameHost />);
    act(() => {
      void askMergeName("main", incoming);
    });
    const input = await screen.findByTestId("merge-name-input");
    fireEvent.change(input, { target: { value: "My name" } });
    const button = screen.getByTestId("merge-name-suggest");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Keep mine" }));
    expect(input).toHaveValue("My name");
  });

  it("has no Suggest when the incoming versions are unknown", async () => {
    render(<MergeNameHost />);
    act(() => {
      void askMergeName("main");
    });
    await screen.findByTestId("merge-name-input");
    expect(screen.queryByTestId("merge-name-suggest")).toBeNull();
  });
});
