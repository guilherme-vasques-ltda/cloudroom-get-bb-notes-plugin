import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@get-bb/plugin-sdk": resolve(__dirname, "harness/stub-sdk.ts") } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
