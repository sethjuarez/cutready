// Typed Draftline commands CutReady calls directly (the rest go through the facade).
import type { RenameVariationResult, SyncStatus, VariationRenamePreflight, VariationRenameToken } from "@draftline/client";
import type { DraftlineSendResult, MoveProjectFolderResult } from "../services/draftlineVersioning";
import { invoke } from "../services/tauri";

export interface DraftlineSendForReviewRequest {
  workspace_path: string;
  remote: string;
  title: string;
  body: string | null;
  base: string | null;
}

const call = <T>(command: string, request: object) => invoke<T>(command, { request });

export const draftlineIpc = {
  deleteVariation: (workspace_path: string, variation: string) => call<void>("delete_variation", { workspace_path, variation }),
  preflightRenameVariation: (workspace_path: string, source_variation_id: string, target_variation_id: string) =>
    call<VariationRenamePreflight>("preflight_rename_variation", { workspace_path, source_variation_id, target_variation_id }),
  renameVariation: (workspace_path: string, source_variation_id: string, target_variation_id: string, token?: VariationRenameToken) =>
    call<RenameVariationResult>("rename_variation", { workspace_path, source_variation_id, target_variation_id, token }),
  addRemote: (workspace_path: string, name: string, url: string) => call<{ name: string; url: string }>("add_remote", { workspace_path, name, url }),
  sendForReview: (request: DraftlineSendForReviewRequest) => call<DraftlineSendResult>("send_for_review", request),
  syncStatus: (workspace_path: string, remote: string) => call<SyncStatus>("get_sync_status", { workspace_path, remote }),
  getBaseStatus: (workspace_path: string, remote: string) => call<SyncStatus | null>("get_base_status", { workspace_path, remote }),
  retryContentDownload: (workspace_path: string) => call<boolean>("retry_content_download", { workspace_path }),
  moveProjectFolder: (workspace_path: string, to: string) => call<MoveProjectFolderResult>("move_project_folder", { workspace_path, to }),
};
