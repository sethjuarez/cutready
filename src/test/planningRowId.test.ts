import { describe, expect, it } from "vitest";
import { newPlanningRowId } from "../utils/planningRowId";

describe("newPlanningRowId", () => {
  it("mints distinct non-empty ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newPlanningRowId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).not.toBe("");
  });
});
