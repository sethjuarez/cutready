// Shows one document with the editor for its kind. Edits are submitted with
// the version this view loaded, so a change from elsewhere is refused as
// stale_document instead of being overwritten.
import { h, render } from "../ui/dom.js";
import { noteView } from "./note.js";
import { sketchView } from "./sketch.js";
import { storyboardView } from "./storyboard.js";

const EDITORS = { sketch: sketchView, storyboard: storyboardView, note: noteView };

/**
 * @param {HTMLElement} container
 * @param {object} state
 * @param {object|null} state.doc `{ path, kind, version, content }`
 * @param {Array} state.documents the project's document list
 * @param {(ops: object[]) => void} state.onEdit
 */
export function renderDocument(container, { doc, documents, loading, onEdit }) {
    if (loading) return render(container, h("p", { class: "muted" }, "Loading…"));
    if (!doc) return render(container, h("p", { class: "muted" }, "Pick a document to view or edit it."));
    const editor = EDITORS[doc.kind];
    render(
        container,
        h("header", { class: "doc-header" }, h("h1", {}, doc.path), h("span", { class: "badge" }, doc.kind)),
        editor ? editor(doc, onEdit, { documents }) : h("p", { class: "muted" }, "This kind of document can't be edited here."),
    );
}
