import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@auditaur/api": fileURLToPath(new URL("./src/test/mocks/auditaurApi.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "docs/**"],
    // @auditaur/api's dist uses extensionless ESM imports that Node can't load; let Vite transform it.
    server: { deps: { inline: [/@auditaur[\\/]api/] } },
  },
});
