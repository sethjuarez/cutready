// Sketch editor: title, description and the planning table. Each committed
// field becomes one typed EditOp; locked rows and cells are read-only.
import { field, h } from "../ui/dom.js";

const CELLS = [
    ["time", "Time", false],
    ["narrative", "Narrative", true],
    ["demo_actions", "Actions", true],
];

const isLocked = (sketch, row, cell) => Boolean(sketch.locked || row.locked || row.locks?.[cell]);

export function sketchView(doc, edit) {
    const sketch = doc.content;
    const rows = sketch.rows ?? [];
    const description = sketch.description;
    const newRow = (afterRowId) =>
        edit([{ kind: "insert_row", after_row_id: afterRowId, row: { time: "", narrative: "", demo_actions: "", screenshot: null } }]);

    return h(
        "div",
        { class: "sketch" },
        field({
            value: sketch.title,
            label: "Title",
            disabled: Boolean(sketch.locked),
            onCommit: (title) => edit([{ kind: "set_title", title }]),
        }),
        description === null || typeof description === "string"
            ? field({
                  value: description ?? "",
                  label: "Description",
                  multiline: true,
                  disabled: Boolean(sketch.locked),
                  onCommit: (text) => edit([{ kind: "set_description", description: text || null }]),
              })
            : h("p", { class: "muted" }, "Rich-text description: edit it in CutReady."),
        h(
            "table",
            { class: "planning" },
            h("thead", {}, h("tr", {}, CELLS.map(([, title]) => h("th", {}, title)), h("th", { "aria-label": "Row actions" }))),
            h(
                "tbody",
                {},
                rows.map((row) =>
                    h(
                        "tr",
                        { class: row.locked ? "locked" : null },
                        CELLS.map(([cell, title, multiline]) =>
                            h(
                                "td",
                                {},
                                field({
                                    value: row[cell],
                                    label: `${title} for row ${row.id}`,
                                    multiline,
                                    disabled: isLocked(sketch, row, cell),
                                    onCommit: (text) => edit([{ kind: "set_row_text", row_id: row.id, [cell]: text }]),
                                }),
                            ),
                        ),
                        h(
                            "td",
                            { class: "row-actions" },
                            h("button", { type: "button", title: "Insert a row below", onclick: () => newRow(row.id) }, "+"),
                            h(
                                "button",
                                {
                                    type: "button",
                                    title: "Delete row",
                                    disabled: Boolean(sketch.locked || row.locked),
                                    onclick: () => edit([{ kind: "delete_row", row_id: row.id }]),
                                },
                                "×",
                            ),
                        ),
                    ),
                ),
            ),
        ),
        h("button", { type: "button", disabled: Boolean(sketch.locked), onclick: () => newRow(rows.at(-1)?.id ?? null) }, "Add row"),
    );
}
