// Typed web fetches used by chat references.
import { invoke } from "../services/tauri";

export const webIpc = {
  fetchUrlContent: (url: string) => invoke<string>("fetch_url_content", { url }),
};
