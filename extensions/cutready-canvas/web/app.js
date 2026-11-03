// The panel: holds view state, wires the views to the API, and refreshes on
// server events so agent edits show up without polling.
import { api, subscribe } from "./api.js";
import { showError } from "./ui/errors.js";
import { renderBrowser } from "./views/browser.js";
import { renderDocument } from "./views/document.js";
import { renderReview } from "./views/review.js";

const $ = (id) => document.getElementById(id);
const state = { documents: null, selected: null, doc: null, loading: false, pending: null, busy: false };

function fail(error, retry) {
    showError($("error"), error, retry);
}

function draw() {
    renderBrowser($("browser"), { documents: state.documents, selected: state.selected, onSelect: select });
    renderDocument($("document"), { doc: state.doc, documents: state.documents, loading: state.loading, onEdit: edit });
    renderReview($("review"), { pending: state.pending, busy: state.busy, onResolve: resolve, onOpen: select });
}

async function loadDocuments() {
    try {
        state.documents = (await api.documents()).documents;
    } catch (error) {
        state.documents = [];
        fail(error, { label: "Retry", run: refresh });
    }
}

async function loadReviews() {
    try {
        state.pending = await api.reviews();
    } catch (error) {
        state.pending = [];
        fail(error, { label: "Retry", run: refresh });
    }
}

async function loadDocument() {
    const path = state.selected;
    if (!path) return;
    try {
        const doc = await api.document(path);
        if (state.selected === path) state.doc = doc;
    } catch (error) {
        if (state.selected !== path) return;
        state.doc = null;
        fail(error, { label: "Retry", run: refresh });
    }
}

async function select(path) {
    state.selected = path;
    state.doc = null;
    state.loading = true;
    showError($("error"), null);
    draw();
    await loadDocument();
    if (state.selected !== path) return;
    state.loading = false;
    draw();
}

async function edit(ops) {
    const doc = state.doc;
    if (!doc) return;
    try {
        await api.edit(doc.path, doc.version, ops);
        showError($("error"), null);
    } catch (error) {
        fail(error, error.code === "stale_document" ? { label: "Reload document", run: refresh } : undefined);
    }
    await refresh();
}

async function resolve(decision, item) {
    state.busy = true;
    draw();
    try {
        await api.resolve(decision, item);
    } catch (error) {
        fail(error, { label: "Reload", run: refresh });
    }
    state.busy = false;
    await refresh();
}

let refreshing;
let again = false;
/**
 * Reloads everything. A call during a reload queues exactly one more, so a
 * change that lands mid-reload is never lost.
 */
function refresh() {
    if (refreshing) {
        again = true;
        return refreshing;
    }
    refreshing = (async () => {
        do {
            again = false;
            await Promise.all([loadDocuments(), loadReviews(), loadDocument()]);
        } while (again);
    })().finally(() => {
        refreshing = undefined;
        draw();
    });
    return refreshing;
}

$("refresh").addEventListener("click", () => {
    showError($("error"), null);
    refresh();
});

subscribe((event, data) => {
    if (event === "hello") {
        $("project").textContent = data.project;
        if (data.focus && !state.selected) select(data.focus);
    } else if (event === "changed") {
        refresh();
    } else if (event === "focus") {
        select(data.path);
    } else if (event === "closed") {
        fail({ code: "unauthorized", message: "This canvas panel was closed" });
    }
});

draw();
refresh();
