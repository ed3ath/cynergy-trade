import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
