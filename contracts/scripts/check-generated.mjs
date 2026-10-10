// Regenerates every Typra output and fails when the committed tree drifts from
// the TypeSpec source (modified, deleted, or newly emitted files).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const contractsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(contractsDir);
const generatedPaths = [
  "contracts/vectors.tsp",
  "contracts/generated",
  "crates/cutready-contracts/src/model",
  "crates/cutready-contracts/src/generated_tests",
  "ios/Tests/CutReadyContractConformanceTests/VectorConformanceTests.swift",
  "ios/Tests/CutReadyContractConformanceTests/VectorRunner.swift",
];

execFileSync("npm", ["run", "generate"], { cwd: contractsDir, stdio: "inherit" });

const status = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", ...generatedPaths],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

if (status) {
  console.error("Generated contract output is out of date. Run `npm run generate` in contracts/ and commit:\n" + status);
  process.exit(1);
}
console.log("Generated contract output matches the TypeSpec source.");
