// Tiny DOM helpers. Text always goes in as textContent, never HTML.

/**
 * h("button", { class: "x", onclick: fn, disabled: true }, "Label", child)
 * Attributes starting with "on" become listeners; false/null attributes are skipped.
 */
export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === false || value === null || value === undefined) continue;
        if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else if (key === "value") el.value = value;
        else el.setAttribute(key, value === true ? "" : String(value));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

export function render(container, ...children) {
    container.replaceChildren();
    append(container, children);
}

/**
 * A text field that commits on blur or Enter (Ctrl+Enter for multiline) and
 * only when the value changed.
 */
export function field({ value, label, multiline = false, disabled = false, onCommit }) {
    const input = h(multiline ? "textarea" : "input", {
        value: value ?? "",
        "aria-label": label,
        disabled,
        rows: multiline ? 2 : null,
        title: disabled ? "Locked" : null,
    });
    let committed = value ?? "";
    const commit = () => {
        if (input.value === committed) return;
        committed = input.value;
        onCommit(input.value);
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
        }
    });
    return input;
}
