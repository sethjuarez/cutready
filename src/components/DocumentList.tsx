import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { DocumentState } from "../types/document";

const stateBadgeColors: Record<DocumentState, string> = {
  sketch: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  recording_enriched: "bg-[var(--color-accent)]/10 text-[var(--color-accent)]/80",
  refined: "bg-[var(--color-accent)]/20 text-[var(--color-accent)]",
  final: "bg-[var(--color-text)]/10 text-[var(--color-text)]",
};

const stateLabels: Record<DocumentState, string> = {
  sketch: "Sketch",
  recording_enriched: "Recording",
  refined: "Refined",
  final: "Final",
};

export function DocumentList() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const loadDocuments = useAppStore((s) => s.loadDocuments);
  const createDocument = useAppStore((s) => s.createDocument);
  const openDocument = useAppStore((s) => s.openDocument);
  const deleteDocument = useAppStore((s) => s.deleteDocument);

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    await createDocument(title);
    setNewTitle("");
    setShowCreate(false);
  }, [newTitle, createDocument]);

  return (
    <div className="flex flex-col h-full border-r border-[var(--color-border)]" style={{ width: 240 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Documents
        </span>
        <button
          onClick={() => setShowCreate(true)}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New document"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Create inline form */}
      {showCreate && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setShowCreate(false); setNewTitle(""); }
            }}
            placeholder="Document title"
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      {/* Document list */}
      <div className="flex-1 overflow-y-auto py-1">
        {documents.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--color-text-secondary)]">
            No documents yet
          </div>
        ) : (
          documents.map((doc) => (
            <div
              key={doc.id}
              onClick={() => openDocument(doc.id)}
              className={`group flex items-start gap-2 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors ${
                activeDocumentId === doc.id
                  ? "bg-[var(--color-accent)]/10"
                  : "hover:bg-[var(--color-surface)]"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{doc.title}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${stateBadgeColors[doc.state]}`}>
                    {stateLabels[doc.state]}
                  </span>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${doc.title}"?`)) deleteDocument(doc.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-500 transition-all"
                title="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
