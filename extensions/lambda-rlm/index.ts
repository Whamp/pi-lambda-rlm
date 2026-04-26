// Pi package extension entrypoint.
// Local development uses `pi install /path/to/pi-lambda-rlm`, so this file is
// loaded from the package manifest rather than project-local .pi auto-discovery.
// This is not a symlink: code lives in src/, while runtime assets live here.
export { default } from "../../src/extension.js";
