import { defineConfig } from "oxlint";

import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  rules: {
    // Module-level named functions are clearer for this project than const-bound
    // function expressions, and they avoid temporal-dead-zone hazards in helpers.
    "func-style": "off",
    // Protocol and result object literals are grouped by domain meaning
    // (identity, execution state, diagnostics, output) rather than alphabetically.
    "sort-keys": "off",
  },
});
