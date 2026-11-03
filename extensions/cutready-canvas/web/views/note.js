// Note editor: the markdown source with an explicit Save (one write_note op).
import { h } from "../ui/dom.js";

export function noteView(doc, edit) {
    const text = h("textarea", { class: "note", value: doc.content, "aria-label": `Markdown for ${doc.path}`, spellcheck: "true" });
    const save = h("button", { type: "button", disabled: true, onclick: () => edit([{ kind: "write_note", content: text.value }]) }, "Save");
    text.addEventListener("input", () => {
        save.disabled = text.value === doc.content;
    });
    text.addEventListener("keydown", (event) => {
        if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!save.disabled) save.click();
        }
    });
    return h("div", { class: "note-editor" }, text, h("div", { class: "actions" }, save));
}
