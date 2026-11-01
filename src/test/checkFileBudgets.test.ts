import { describe, expect, it } from "vitest";
import {
  checkFileBudgets,
  countLines,
  isBudgeted,
  updateBudgets,
  // @ts-expect-error - plain .mjs script without type declarations
} from "../../scripts/check-file-budgets.mjs";

const config = { limit: 800, budgets: { "src/big.ts": 1000, "src-tauri/src/huge.rs": 2000 } };

describe("check-file-budgets", () => {
  it("passes files at their budget and new files under the limit", () => {
    expect(
      checkFileBudgets({ "src/big.ts": 1000, "src-tauri/src/huge.rs": 2000, "src/small.ts": 800 }, config),
    ).toEqual([]);
  });

  it("fails growth, new large files, and stale or missing budgets", () => {
    const problems = checkFileBudgets({ "src/big.ts": 1001, "src-tauri/src/huge.rs": 1500, "src/new.ts": 801 }, config);
    expect(problems).toEqual([
      expect.stringMatching(/^src\/big\.ts: 1001 lines, over its budget of 1000/),
      expect.stringMatching(/^src-tauri\/src\/huge\.rs: 1500 lines, under its budget of 2000; run --update/),
      expect.stringMatching(/^src\/new\.ts: 801 lines, over the 800-line limit/),
    ]);
    expect(checkFileBudgets({ "src/big.ts": 1000 }, config)).toEqual([
      expect.stringMatching(/^src-tauri\/src\/huge\.rs: budgeted but missing/),
    ]);
  });

  it("only lowers budgets and drops files back under the limit", () => {
    expect(updateBudgets({ "src/big.ts": 1200, "src-tauri/src/huge.rs": 700, "src/new.ts": 900 }, config)).toEqual({
      limit: 800,
      budgets: { "src/big.ts": 1000 },
    });
  });

  it("budgets hand-written source only", () => {
    expect(isBudgeted("src/stores/appStore.ts")).toBe(true);
    expect(isBudgeted("crates/cutready-core/src/review.rs")).toBe(true);
    expect(isBudgeted("src/contracts/generated/models.ts")).toBe(false);
    expect(isBudgeted("crates/cutready-contracts/src/model/x.rs")).toBe(false);
    expect(isBudgeted("crates/cutready-cli/tests/cli.rs")).toBe(false);
    expect(isBudgeted("src-tauri/src/engine/agent/prompty_integration_tests.rs")).toBe(false);
    expect(isBudgeted("src/test/app.test.ts")).toBe(false);
  });

  it("counts lines like wc -l plus an unterminated last line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n\nb\n")).toBe(3);
    expect(countLines("a\r\nb")).toBe(2);
  });
});
