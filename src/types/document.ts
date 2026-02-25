/** TypeScript types for sketch documents (Phase 2). */

/** Lifecycle state of a sketch document. */
export type DocumentState =
  | "sketch"
  | "recording_enriched"
  | "refined"
  | "final";

/** A row in the sketch planning table (4 columns). */
export interface PlanningRow {
  id: string;
  time: string;
  narrative: string;
  demo_actions: string;
  screenshot: string | null;
}

/** A section within a sketch document containing planning table rows. */
export interface DocumentSection {
  id: string;
  title: string;
  description: string;
  rows: PlanningRow[];
}

/** A sketch document — the primary authoring artifact. */
export interface Document {
  id: string;
  title: string;
  description: string;
  sections: DocumentSection[];
  /** Lexical editor state JSON — opaque to the backend. */
  content: unknown;
  state: DocumentState;
  created_at: string;
  updated_at: string;
}

/** Lightweight summary for listing documents. */
export interface DocumentSummary {
  id: string;
  title: string;
  state: DocumentState;
  created_at: string;
  updated_at: string;
}

/** An entry in the project's version history. */
export interface VersionEntry {
  id: string;
  message: string;
  timestamp: string;
  summary: string;
}
