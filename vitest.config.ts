import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // New provider code needs tests. Branches leave room for defensive checks.
      thresholds: { statements: 100, functions: 100, lines: 100, branches: 95 },
    },
  },
});
