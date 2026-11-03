// The document list, grouped by kind. Documents that don't parse are listed
// with their error so the user knows why they can't be opened.
import { h, render } from "../ui/dom.js";

const GROUPS = [
    ["storyboard", "Storyboards"],
    ["sketch", "Sketches"],
    ["note", "Notes"],
];

export function renderBrowser(container, { documents, selected, onSelect }) {
    if (!documents) return render(container, h("p", { class: "muted" }, "Loading…"));
    const sections = GROUPS.map(([kind, title]) => {
        const docs = documents.filter((doc) => doc.kind === kind);
        if (!docs.length) return null;
        return h(
            "section",
            {},
            h("h2", {}, title),
            h(
                "ul",
                {},
                docs.map((doc) =>
                    h(
                        "li",
                        {},
                        h(
                            "button",
                            {
                                type: "button",
                                class: doc.path === selected ? "item selected" : "item",
                                "aria-current": doc.path === selected ? "true" : null,
                                title: doc.ok ? doc.path : `${doc.path}: ${doc.error?.message ?? "invalid"}`,
                                onclick: () => onSelect(doc.path),
                            },
                            doc.path,
                            doc.ok ? null : h("span", { class: "badge danger" }, doc.error?.code ?? "invalid"),
                        ),
                    ),
                ),
            ),
        );
    });
    render(container, documents.length ? sections : h("p", { class: "muted" }, "No sketches, storyboards or notes in this project yet."));
}
