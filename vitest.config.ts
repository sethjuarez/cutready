import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node 25+ ships a global Web Storage `localStorage` that shadows jsdom's and is
// undefined without `--localstorage-file`. Turn it off so tests use jsdom's.
const nodeWebStorageFlag = "--experimental-webstorage";
const execArgv = process.allowedNodeEnvironmentFlags.has(nodeWebStorageFlag)
  ? ["--no-experimental-webstorage"]
  : [];

export default defineConfig({
  resolve: {
    alias: {
      "@auditaur/api": fileURLToPath(new URL("./src/test/mocks/auditaurApi.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    execArgv,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "docs/**"],
  },
});
