import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/server/test/**/*.test.ts"],
    globalSetup: ["./scripts/test-database.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
