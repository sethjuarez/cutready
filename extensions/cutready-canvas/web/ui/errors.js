// Turns canvas and cutready-cli error codes into a message and next step.
import { h, render } from "./dom.js";

const HINTS = {
    stale_document: "This document changed since you opened it. Reload it, then make your edit again.",
    stale_review: "The document changed after this run's edits. Reload the review list.",
    undo_conflict: "This document changed after the run's edits, so they can't be undone automatically.",
    locked_document: "This document is locked. Unlock it in CutReady to edit it.",
    locked_row: "This row is locked. Unlock it in CutReady to edit it.",
    locked_row_count: "Locked rows can't be added or removed around.",
    locked_cell: "That cell is locked. Unlock it in CutReady to edit it.",
    row_not_found: "That row no longer exists. Reload the document.",
    contract_mismatch: "This canvas and the installed cutready-cli speak different edit contracts. Update CutReady or the canvas so they match.",
    cli_not_found: "No cutready-cli was found. Start the CutReady app once (it registers its CLI), or reopen the canvas with cliPath.",
    handshake_failed: "cutready-cli couldn't open this folder as a CutReady project.",
    process_exited: "cutready-cli stopped. The next action restarts it.",
    no_project: "Open the canvas on a CutReady project folder.",
    canvas_offline: "The canvas server stopped. Reopen the canvas.",
    unauthorized: "This canvas panel was closed. Reopen it.",
};

/** Shows `error` in `container`, with an optional action button. Pass null to clear. */
export function showError(container, error, action) {
    if (!error) return render(container);
    const hint = HINTS[error.code];
    render(
        container,
        h(
            "div",
            { class: "error" },
            h("div", {}, h("strong", {}, error.message || "Something went wrong"), " ", h("code", {}, error.code ?? "error")),
            hint ? h("div", { class: "muted" }, hint) : null,
            h(
                "div",
                { class: "actions" },
                action ? h("button", { type: "button", onclick: action.run }, action.label) : null,
                h("button", { type: "button", onclick: () => render(container) }, "Dismiss"),
            ),
        ),
    );
}
