import type { PlanningCellField, PlanningRow } from "../../types/sketch";

/* Row accent colors — thin left stripe for visual anchoring */
const ROW_PALETTES: Record<string, string[]> = {
  vivid: [
    "#60a5fa", "#34d399", "#fbbf24", "#a78bfa",
    "#fb7185", "#22d3ee", "#f97316", "#a3e635",
  ],
  pastel: [
    "#93c5fd", "#6ee7b7", "#fde68a", "#c4b5fd",
    "#fda4af", "#67e8f9", "#fdba74", "#d9f99d",
  ],
  neutral: [
    "#9ca3af", "#9ca3af", "#9ca3af", "#9ca3af",
    "#9ca3af", "#9ca3af", "#9ca3af", "#9ca3af",
  ],
};


export function getRowColor(idx: number): string {
  const palette = getComputedStyle(document.documentElement).getPropertyValue("--row-color-palette").trim() || "vivid";
  const colors = ROW_PALETTES[palette] ?? ROW_PALETTES.vivid;
  return colors[idx % colors.length];
}

export function isCellLocked(row: PlanningRow, field: PlanningCellField): boolean {
  return row.locked === true || row.locks?.[field] === true;
}

export function hasAnyLock(row: PlanningRow): boolean {
  return row.locked === true || Object.values(row.locks ?? {}).some(Boolean);
}
