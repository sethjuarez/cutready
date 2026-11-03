// Storyboard editor: title and the item sequence. Sketches can be added from
// the project's list, and items removed or moved with typed item ops.
import { field, h } from "../ui/dom.js";

function describe(item) {
    if (item.type === "sketch_ref") return h("span", {}, item.path);
    if (item.type === "section") {
        return h("span", {}, h("strong", {}, item.title), ` (${(item.sketches ?? []).length} sketches)`);
    }
    return h("span", { class: "muted" }, item.type ?? "item");
}

export function storyboardView(doc, edit, { documents }) {
    const storyboard = doc.content;
    const items = storyboard.items ?? [];
    const locked = Boolean(storyboard.locked);
    const sketches = (documents ?? []).filter((d) => d.kind === "sketch").map((d) => d.path);
    const move = (index, delta) => {
        const next = [...items];
        const [item] = next.splice(index, 1);
        next.splice(index + delta, 0, item);
        edit([{ kind: "set_storyboard_items", items: next }]);
    };
    const picker = h("select", { "aria-label": "Sketch to add", disabled: locked || !sketches.length }, sketches.map((p) => h("option", { value: p }, p)));

    return h(
        "div",
        { class: "storyboard" },
        field({ value: storyboard.title, label: "Title", disabled: locked, onCommit: (title) => edit([{ kind: "set_title", title }]) }),
        h(
            "ol",
            { class: "items" },
            items.map((item, index) =>
                h(
                    "li",
                    {},
                    describe(item),
                    h(
                        "span",
                        { class: "row-actions" },
                        h("button", { type: "button", title: "Move up", disabled: locked || index === 0, onclick: () => move(index, -1) }, "↑"),
                        h(
                            "button",
                            { type: "button", title: "Move down", disabled: locked || index === items.length - 1, onclick: () => move(index, 1) },
                            "↓",
                        ),
                        h(
                            "button",
                            { type: "button", title: "Remove", disabled: locked, onclick: () => edit([{ kind: "remove_storyboard_item", index }]) },
                            "×",
                        ),
                    ),
                ),
            ),
        ),
        h(
            "div",
            { class: "actions" },
            picker,
            h(
                "button",
                {
                    type: "button",
                    disabled: locked || !sketches.length,
                    onclick: () => edit([{ kind: "insert_storyboard_item", index: null, item: { type: "sketch_ref", path: picker.value } }]),
                },
                "Add sketch",
            ),
        ),
    );
}
