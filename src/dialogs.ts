// The only module allowed to import @tauri-apps/plugin-dialog (enforced in src/test/dialogs.test.ts).
// Outside an Auditaur drill every call goes straight to the plugin; armed drills answer from a queue.
import * as dialog from "@tauri-apps/plugin-dialog";
import { withDrillDialogs } from "@auditaur/api";

export const { open, save, ask, confirm, message } = withDrillDialogs(dialog);
