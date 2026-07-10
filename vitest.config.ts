import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["dashboard/src/test/setup.ts"],
    include: ["dashboard/src/**/*.test.ts"],
    benchmark: {
      include: ["dashboard/src/**/*.bench.ts"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "dashboard/src"),
    },
  },
});