// Typed OS accessibility reads.
import { invoke } from "../services/tauri";

export interface SystemAccessibilityDisplay {
  increaseContrast: boolean;
  differentiateWithoutColor: boolean;
}

export const accessibilityIpc = {
  /** Null outside the desktop app (devMock answers unknown commands with null). */
  getSystemAccessibilityDisplay: () =>
    invoke<SystemAccessibilityDisplay | null>("get_system_accessibility_display"),
};
