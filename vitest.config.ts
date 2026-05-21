import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Fail fast on accidental network use: these tests must stay deterministic.
    testTimeout: 5_000,
  },
});
