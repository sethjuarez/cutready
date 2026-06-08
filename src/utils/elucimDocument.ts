import type { CutReadyElucimDocument } from "../types/elucim";

export interface ElucimDocumentSize {
  width: number;
  height: number;
}

export const DEFAULT_ELUCIM_DOCUMENT_SIZE: ElucimDocumentSize = {
  width: 960,
  height: 540,
};

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getElucimDocumentSize(
  document: CutReadyElucimDocument | null | undefined,
  fallback: ElucimDocumentSize = DEFAULT_ELUCIM_DOCUMENT_SIZE,
): ElucimDocumentSize {
  if (!document) return fallback;

  if ("scene" in document) {
    return {
      width: numberOrFallback(document.scene.width, fallback.width),
      height: numberOrFallback(document.scene.height, fallback.height),
    };
  }

  return {
    width: numberOrFallback(document.root.width, fallback.width),
    height: numberOrFallback(document.root.height, fallback.height),
  };
}
