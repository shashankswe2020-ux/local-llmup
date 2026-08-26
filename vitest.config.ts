import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup/interactive-ink.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 70,
        "src/ranking/**": { lines: 80, branches: 80 },
        "src/hardware/**": { lines: 80, branches: 80 },
        "src/catalog/**": { lines: 80, branches: 80 },
        "src/memory/**": { lines: 80, branches: 80 },
        "src/backend/**": { lines: 80, branches: 80 },
        "src/state/**": { lines: 80, branches: 80 },
      },
    },
  },
});
