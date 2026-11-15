import { defineConfig } from "vitest/config";
// Tests share one database, so files run one after another.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 } });
