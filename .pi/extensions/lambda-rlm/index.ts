// Project-local Pi extension entrypoint.
// Pi auto-loads .pi/extensions/*/index.ts when an agent starts in this repo,
// so this shim dogfoods lambda_rlm before any global install. Schema/load
// errors here can affect ordinary Pi turns before lambda_rlm is called.
// This is not a symlink: code lives in src/, while runtime assets live here.
export { default } from "../../../src/extension.js";
