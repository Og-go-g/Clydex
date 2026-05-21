import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    // Exclude Claude session worktrees — they're frozen snapshots of
    // earlier branches that intentionally have ECONNREFUSED tests
    // against a locally-running PG that we no longer have. Sweeping
    // them inflates the test count and pollutes failure signal.
    // Also exclude the standard tooling output dirs.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.claude/worktrees/**",
      "**/dist/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
