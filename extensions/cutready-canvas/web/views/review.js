// Pending runs this canvas (usually the agent) began, with Keep and Undo per
// document. Kept edits stay; undone edits restore the document.
import { h, render } from "../ui/dom.js";

function when(stamp) {
    const date = new Date(stamp);
    return Number.isNaN(date.getTime()) ? String(stamp ?? "") : date.toLocaleString();
}

export function renderReview(container, { pending, busy, onResolve, onOpen }) {
    if (!pending) return render(container, h("h2", {}, "Pending review"), h("p", { class: "muted" }, "Loading…"));
    render(
        container,
        h("h2", {}, "Pending review", pending.length ? h("span", { class: "badge" }, String(pending.length)) : null),
        pending.length
            ? h(
                  "ul",
                  { class: "pending" },
                  pending.map((item) =>
                      h(
                          "li",
                          {},
                          h("button", { type: "button", class: "link", onclick: () => onOpen(item.path) }, item.path),
                          h(
                              "div",
                              { class: "muted small" },
                              `${item.created ? "Created" : `${item.writes} write${item.writes === 1 ? "" : "s"}`} · ${item.actor} · ${when(item.last_at)}`,
                          ),
                          h(
                              "div",
                              { class: "actions" },
                              h("button", { type: "button", class: "primary", disabled: busy, onclick: () => onResolve("keep", item) }, "Keep"),
                              h("button", { type: "button", disabled: busy, onclick: () => onResolve("undo", item) }, "Undo"),
                          ),
                      ),
                  ),
              )
            : h("p", { class: "muted" }, "Nothing waiting. Agent edits made through this canvas show up here."),
    );
}
