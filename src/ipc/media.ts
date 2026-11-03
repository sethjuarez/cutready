// Typed reads of row media assets for the planning table.
import { invoke } from "../services/tauri";

export interface NarrationAsset {
  data: number[];
  mimeType: string;
}

export const mediaIpc = {
  readNarrationAsset: (relativePath: string) =>
    invoke<NarrationAsset>("read_narration_asset", { relativePath }),
};