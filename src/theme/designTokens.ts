/**
 * Direction C density: two levels that change spacing only. Text size never
 * shrinks with density (see the type scale in src/index.css).
 */
export const DENSITY_OPTIONS = ["compact", "comfortable"] as const;
export type Density = (typeof DENSITY_OPTIONS)[number];

/** Legacy "spacious" and unknown values read as comfortable. */
export function normalizeDensity(value: string | undefined | null): Density {
  return value === "compact" ? "compact" : "comfortable";
}

/** Row padding/line-height consumed by the planning tables via --row-* vars. */
export const DENSITY_ROW_VARS: Record<Density, { padding: string; lineHeight: string }> = {
  compact: { padding: "0.25rem 0.5rem", lineHeight: "1.4" },
  comfortable: { padding: "0.5rem 0.75rem", lineHeight: "1.5" },
};
